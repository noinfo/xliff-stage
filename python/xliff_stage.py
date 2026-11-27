#!/usr/bin/env python3
"""xliff-stage: stage only the XLIFF translation units that belong to your changes.

The helper diffs the current branch (including uncommitted work) against a base
branch, collects the i18n IDs that appear on changed lines of source files
(e.g. ``i18n="@@checkout.title"`` or ``$localize`:@@checkout.title:Checkout```),
and then stages only the ``<trans-unit>`` (XLIFF 1.2) / ``<unit>`` (XLIFF 2.0)
blocks with those IDs in the modified XLIFF files. Every other XLIFF change
stays unstaged in the working tree.

Staging works on the index directly: for each XLIFF file the staged version is
taken as the starting point, the selected units are copied over from the
working-tree version (changed, added or removed), and the result is written to
the index. The working tree is never touched, so running it twice is harmless.

Requires Python 3.8+ and git. No third-party packages.
"""

from __future__ import annotations

import argparse
import fnmatch
import html
import re
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

__version__ = "1.0.0"

DEFAULT_ID_PATTERNS = [
    # Angular templates (i18n="meaning|description@@id", i18n-title="@@id")
    # and $localize`:meaning|description@@id:text`.
    r"@@([A-Za-z0-9_.\-]+)",
]
DEFAULT_XLIFF_GLOBS = ["*.xlf", "*.xliff", "*.xlf2"]

# A unit block, including its indentation and the line break after it, so that
# blocks can be inserted and removed without leaving blank lines behind.
UNIT_RE = re.compile(
    r"(?P<block>[ \t]*<(?P<tag>trans-unit|unit)\b(?P<attrs>[^>]*)>.*?</(?P=tag)\s*>[ \t]*(?:\r?\n)?)",
    re.DOTALL,
)
ID_ATTR_RE = re.compile(r"""\bid\s*=\s*(?:"([^"]*)"|'([^']*)')""")
# Where to append a unit when the staged file has no units at all.
CONTAINER_END_RE = re.compile(r"[ \t]*</(?:body|group|file)\s*>")


class HelperError(Exception):
    pass


# --------------------------------------------------------------------------- git


def git(args: Sequence[str], cwd: Optional[str] = None, input_bytes: Optional[bytes] = None,
        check: bool = True) -> bytes:
    proc = subprocess.run(
        ["git", *args], cwd=cwd, input=input_bytes,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if check and proc.returncode != 0:
        raise HelperError(f"git {' '.join(args)} failed:\n{proc.stderr.decode(errors='replace').strip()}")
    return proc.stdout


def git_text(args: Sequence[str], cwd: Optional[str] = None, check: bool = True) -> str:
    return git(args, cwd=cwd, check=check).decode("utf-8", errors="replace")


def resolve_base(base: str, cwd: str) -> str:
    """Return the merge-base commit between HEAD and the base branch."""
    candidates = [base]
    if not base.startswith("origin/"):
        candidates.append(f"origin/{base}")
    for cand in candidates:
        if git(["rev-parse", "--verify", "--quiet", f"{cand}^{{commit}}"], cwd=cwd, check=False).strip():
            mb = git_text(["merge-base", "HEAD", cand], cwd=cwd, check=False).strip()
            if mb:
                return mb
            raise HelperError(f"'{cand}' has no common history with HEAD")
    raise HelperError(f"base branch '{base}' not found (tried: {', '.join(candidates)})")


def is_xliff(path: str, globs: Sequence[str]) -> bool:
    name = path.rsplit("/", 1)[-1]
    return any(fnmatch.fnmatch(name, g) or fnmatch.fnmatch(path, g) for g in globs)


# --------------------------------------------------------------------- ID scan


def changed_lines_from_diff(diff: str) -> Dict[str, List[str]]:
    """Map file path -> added/removed lines, from a unified diff."""
    result: Dict[str, List[str]] = {}
    current: Optional[str] = None
    in_hunk = False
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            current, in_hunk = None, False
            continue
        if not in_hunk and line.startswith("+++ "):
            p = line[4:]
            if p.startswith("b/"):
                current = p[2:]
            elif p == "/dev/null":
                current = current  # file deleted, keep the "---" name
            continue
        if not in_hunk and line.startswith("--- "):
            p = line[4:]
            current = p[2:] if p.startswith("a/") else None
            continue
        if line.startswith("@@"):
            in_hunk = True
            continue
        if in_hunk and current and line[:1] in ("+", "-"):
            result.setdefault(current, []).append(line[1:])
    return result


def extract_ids(lines: Iterable[str], patterns: Sequence["re.Pattern[str]"]) -> Set[str]:
    ids: Set[str] = set()
    for line in lines:
        for pat in patterns:
            for m in pat.finditer(line):
                value = m.group(1) if pat.groups else m.group(0)
                if value:
                    ids.add(value)
    return ids


def collect_ids(cwd: str, base_commit: str, patterns: Sequence["re.Pattern[str]"],
                xliff_globs: Sequence[str], include_untracked: bool = True,
                pathspec: Sequence[str] = ()) -> Tuple[Set[str], Dict[str, Set[str]]]:
    """IDs on changed lines of non-XLIFF files, comparing the merge-base to the working tree."""
    diff = git_text(["diff", "--no-color", "--no-ext-diff", "-U0", base_commit, "--", *pathspec], cwd=cwd)
    per_file: Dict[str, Set[str]] = {}
    for path, lines in changed_lines_from_diff(diff).items():
        if is_xliff(path, xliff_globs):
            continue
        found = extract_ids(lines, patterns)
        if found:
            per_file[path] = found
    if include_untracked:
        untracked = git_text(["ls-files", "-z", "--others", "--exclude-standard", "--", *pathspec], cwd=cwd)
        for path in filter(None, untracked.split("\0")):
            if is_xliff(path, xliff_globs):
                continue
            try:
                with open(f"{cwd}/{path}", encoding="utf-8", errors="replace") as fh:
                    found = extract_ids(fh.read().splitlines(), patterns)
            except (OSError, IsADirectoryError):
                continue
            if found:
                per_file[path] = found
    all_ids: Set[str] = set().union(*per_file.values()) if per_file else set()
    return all_ids, per_file


# ------------------------------------------------------------------ XLIFF units


@dataclass
class Unit:
    id: str
    start: int
    end: int
    text: str


def parse_units(content: str) -> List[Unit]:
    units = []
    for m in UNIT_RE.finditer(content):
        id_m = ID_ATTR_RE.search(m.group("attrs"))
        if not id_m:
            continue
        raw = id_m.group(1) if id_m.group(1) is not None else id_m.group(2)
        units.append(Unit(html.unescape(raw), m.start(), m.end(), m.group("block")))
    return units


@dataclass
class MergeResult:
    content: str
    changed: List[str] = field(default_factory=list)
    added: List[str] = field(default_factory=list)
    removed: List[str] = field(default_factory=list)

    @property
    def touched(self) -> int:
        return len(self.changed) + len(self.added) + len(self.removed)


def merge_units(staged: str, worktree: str, ids: Set[str]) -> MergeResult:
    """Return ``staged`` with the units whose id is in ``ids`` taken from ``worktree``."""
    s_units = parse_units(staged)
    w_units = parse_units(worktree)
    s_by_id = {u.id: u for u in s_units}
    w_by_id = {u.id: u for u in w_units}

    result = MergeResult(staged)
    replace: Dict[str, str] = {}
    remove: Set[str] = set()
    # anchor id (unit in staged file) -> units to insert after it; None = before the first unit
    insert_after: Dict[Optional[str], List[str]] = {}

    for uid in ids:
        if uid in s_by_id and uid in w_by_id:
            if s_by_id[uid].text != w_by_id[uid].text:
                replace[uid] = w_by_id[uid].text
                result.changed.append(uid)
        elif uid in s_by_id:
            remove.add(uid)
            result.removed.append(uid)

    anchor: Optional[str] = None
    for u in w_units:
        if u.id in s_by_id:
            anchor = u.id
        elif u.id in ids:
            insert_after.setdefault(anchor, []).append(u.text)
            result.added.append(u.id)

    if not (replace or remove or insert_after):
        return result

    out: List[str] = []
    pos = 0
    if s_units:
        for i, u in enumerate(s_units):
            out.append(staged[pos:u.start])
            if i == 0 and None in insert_after:
                out.extend(insert_after[None])
            if u.id not in remove:
                out.append(replace.get(u.id, u.text))
            out.extend(insert_after.get(u.id, []))
            pos = u.end
        out.append(staged[pos:])
    else:
        new_blocks = insert_after.get(None, [])
        m = CONTAINER_END_RE.search(staged)
        if not m:
            raise HelperError("no units and no </body>/</file> found to insert new units into")
        out = [staged[:m.start()], *new_blocks, staged[m.start():]]
    result.content = "".join(out)
    result.changed.sort()
    result.removed.sort()
    return result


# --------------------------------------------------------------------- staging


def modified_xliff_files(cwd: str, globs: Sequence[str], pathspec: Sequence[str]) -> List[str]:
    """XLIFF files whose working-tree content differs from the index."""
    out = git_text(["diff", "--name-only", "-z", "--diff-filter=M", "--", *pathspec], cwd=cwd)
    return [p for p in out.split("\0") if p and is_xliff(p, globs)]


def index_entry(cwd: str, path: str) -> Tuple[str, bytes]:
    line = git_text(["ls-files", "-s", "--", path], cwd=cwd).split("\n", 1)[0]
    mode = line.split(" ", 1)[0]
    return mode, git(["show", f":{path}"], cwd=cwd)


def decode(data: bytes, path: str) -> Tuple[str, str]:
    """Decode file bytes; return (text, encoding to write it back with)."""
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16"), "utf-16"
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HelperError(f"{path}: cannot decode file (expected UTF-8 or UTF-16 with BOM)")
    return text, ("utf-8-sig" if data.startswith(b"\xef\xbb\xbf") else "utf-8")


def stage_content(cwd: str, path: str, mode: str, data: bytes) -> None:
    sha = git(["hash-object", "-w", "--stdin"], cwd=cwd, input_bytes=data).decode().strip()
    git(["update-index", "--cacheinfo", f"{mode},{sha},{path}"], cwd=cwd)


def unified_diff(path: str, before: str, after: str) -> str:
    import difflib
    return "".join(difflib.unified_diff(
        before.splitlines(keepends=True), after.splitlines(keepends=True),
        fromfile=f"a/{path} (staged)", tofile=f"b/{path} (would be staged)",
    ))


# ------------------------------------------------------------------------- CLI


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="xliff-stage",
        description="Stage only the XLIFF translation units whose i18n IDs appear in your changes "
                    "(current branch + uncommitted work, compared to a base branch).",
    )
    p.add_argument("-b", "--base", default="main",
                   help="branch to diff against (default: main; falls back to origin/<base>)")
    p.add_argument("-p", "--pattern", action="append", dest="patterns", metavar="REGEX",
                   help="regex that finds an i18n ID in a changed line; the first capture group is "
                        "the ID. Repeatable. Default: '@@([A-Za-z0-9_.\\-]+)'")
    p.add_argument("--id", action="append", dest="extra_ids", default=[], metavar="ID",
                   help="also stage this unit ID (repeatable)")
    p.add_argument("--xliff", action="append", dest="xliff_globs", metavar="GLOB",
                   help="glob for translation files (repeatable). Default: *.xlf *.xliff *.xlf2")
    p.add_argument("--source", action="append", dest="source_paths", default=[], metavar="PATHSPEC",
                   help="limit the ID scan to these source paths (git pathspec, repeatable)")
    p.add_argument("--no-untracked", action="store_true",
                   help="do not scan untracked source files for IDs")
    p.add_argument("-n", "--dry-run", action="store_true",
                   help="show what would be staged without touching the index")
    p.add_argument("--list-ids", action="store_true",
                   help="only print the IDs found in the changes, grouped by file")
    p.add_argument("-q", "--quiet", action="store_true", help="print only errors")
    p.add_argument("-C", dest="cwd", default=".", metavar="PATH", help="run as if started in PATH")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return p


def run(argv: Optional[Sequence[str]] = None, out=sys.stdout) -> int:
    args = build_parser().parse_args(argv)

    def say(msg: str = "") -> None:
        if not args.quiet:
            print(msg, file=out)

    try:
        root = git_text(["rev-parse", "--show-toplevel"], cwd=args.cwd).strip()
    except HelperError:
        print("xliff-stage: not inside a git repository", file=sys.stderr)
        return 2

    try:
        patterns = [re.compile(p) for p in (args.patterns or DEFAULT_ID_PATTERNS)]
    except re.error as exc:
        print(f"xliff-stage: invalid --pattern: {exc}", file=sys.stderr)
        return 2
    globs = args.xliff_globs or DEFAULT_XLIFF_GLOBS

    try:
        base_commit = resolve_base(args.base, root)
        ids, per_file = collect_ids(root, base_commit, patterns, globs,
                                    include_untracked=not args.no_untracked,
                                    pathspec=args.source_paths)
        ids |= set(args.extra_ids)

        if args.list_ids:
            for path in sorted(per_file):
                print(path, file=out)
                for i in sorted(per_file[path]):
                    print(f"  {i}", file=out)
            if args.extra_ids:
                print("(--id)", file=out)
                for i in sorted(set(args.extra_ids)):
                    print(f"  {i}", file=out)
            return 0

        if not ids:
            say(f"No i18n IDs found in changes since {args.base} ({base_commit[:8]}). Nothing staged.")
            return 0
        say(f"Found {len(ids)} i18n ID(s) in changes since {args.base} ({base_commit[:8]}).")

        files = modified_xliff_files(root, globs, [])
        if not files:
            say("No modified (unstaged) XLIFF files.")
            return 0

        total = 0
        for path in files:
            mode, staged_bytes = index_entry(root, path)
            with open(f"{root}/{path}", "rb") as fh:
                work_bytes = fh.read()
            staged, enc = decode(staged_bytes, path)
            work, _ = decode(work_bytes, path)
            res = merge_units(staged, work, ids)
            if not res.touched:
                say(f"  {path}: no matching units changed")
                continue
            total += res.touched
            summary = ", ".join(f"{n} {k}" for k, n in
                                (("changed", len(res.changed)), ("added", len(res.added)),
                                 ("removed", len(res.removed))) if n)
            say(f"  {path}: {summary}")
            if args.dry_run:
                say(unified_diff(path, staged, res.content).rstrip("\n"))
            else:
                stage_content(root, path, mode, res.content.encode(enc))

        verb = "Would stage" if args.dry_run else "Staged"
        say(f"{verb} {total} unit(s). Other XLIFF changes are left unstaged.")
        return 0
    except HelperError as exc:
        print(f"xliff-stage: {exc}", file=sys.stderr)
        return 1


def main() -> None:
    sys.exit(run())


if __name__ == "__main__":
    main()
