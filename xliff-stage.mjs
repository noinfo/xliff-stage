#!/usr/bin/env node
/**
 * xliff-stage: stage only the XLIFF translation units that belong to your changes.
 *
 * Diffs the current branch (including uncommitted work and untracked files)
 * against a base branch, collects the i18n IDs on changed lines of source files
 * (e.g. i18n="desc@@checkout.title" or $localize`:@@checkout.title:Checkout`),
 * and stages only the <trans-unit> (XLIFF 1.2) / <unit> (XLIFF 2.0) blocks with
 * those IDs in modified XLIFF files. All other XLIFF changes stay unstaged.
 *
 * Staging writes to the git index only: the staged version of each XLIFF file
 * is the starting point, matching units are copied over from the working tree
 * (changed, added or removed), and the result is written with
 * `git update-index`. The working tree is never modified.
 *
 * Node 20+ and git. No dependencies.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export const VERSION = '1.0.0';

/** Angular custom IDs: i18n="meaning|desc@@id", i18n-title="@@id", $localize`:@@id:text`. */
export const DEFAULT_ID_PATTERNS = ['@@([A-Za-z0-9_.\\-]+)'];
export const DEFAULT_XLIFF_GLOBS = ['*.xlf', '*.xliff', '*.xlf2'];

// A unit block including its indentation and trailing line break, so blocks
// can be inserted or removed without leaving blank lines behind.
const UNIT_RE =
  /[ \t]*<(?<tag>trans-unit|unit)\b(?<attrs>[^>]*)>[\s\S]*?<\/\k<tag>\s*>[ \t]*(?:\r?\n)?/g;
const ID_ATTR_RE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const CONTAINER_END_RE = /[ \t]*<\/(?:body|group|file)\s*>/;

export class HelperError extends Error {}

// ------------------------------------------------------------------------ git

export function git(args, { cwd, input, check = true } = {}) {
  const res = spawnSync('git', args, { cwd, input, maxBuffer: 1024 * 1024 * 512 });
  if (res.error) throw new HelperError(`could not run git: ${res.error.message}`);
  if (check && res.status !== 0) {
    throw new HelperError(`git ${args.join(' ')} failed:\n${res.stderr.toString().trim()}`);
  }
  return res.stdout;
}

const gitText = (args, opts) => git(args, opts).toString('utf8');

export function resolveBase(base, cwd) {
  const candidates = base.startsWith('origin/') ? [base] : [base, `origin/${base}`];
  for (const cand of candidates) {
    const ok = gitText(['rev-parse', '--verify', '--quiet', `${cand}^{commit}`], { cwd, check: false }).trim();
    if (!ok) continue;
    const mb = gitText(['merge-base', 'HEAD', cand], { cwd, check: false }).trim();
    if (mb) return mb;
    throw new HelperError(`'${cand}' has no common history with HEAD`);
  }
  throw new HelperError(`base branch '${base}' not found (tried: ${candidates.join(', ')})`);
}

function globToRegExp(glob) {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function isXliff(path, globs) {
  const name = path.split('/').pop();
  return globs.some((g) => {
    const re = globToRegExp(g);
    return re.test(name) || re.test(path);
  });
}

// --------------------------------------------------------------------- ID scan

/** Map of file path -> added/removed lines, from a unified diff. */
export function changedLinesFromDiff(diff) {
  const result = new Map();
  let current = null;
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      current = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith('--- ')) {
      const p = line.slice(4);
      current = p.startsWith('a/') ? p.slice(2) : null;
    } else if (!inHunk && line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p.startsWith('b/')) current = p.slice(2); // "/dev/null" keeps the "---" name
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && current && (line[0] === '+' || line[0] === '-')) {
      if (!result.has(current)) result.set(current, []);
      result.get(current).push(line.slice(1));
    }
  }
  return result;
}

export function extractIds(lines, patterns) {
  const ids = new Set();
  for (const line of lines) {
    for (const pat of patterns) {
      const re = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g');
      for (const m of line.matchAll(re)) {
        const value = m.length > 1 ? m[1] : m[0];
        if (value) ids.add(value);
      }
    }
  }
  return ids;
}

/** IDs on changed lines of non-XLIFF files, comparing the merge-base to the working tree. */
export function collectIds(cwd, baseCommit, patterns, xliffGlobs, { includeUntracked = true, pathspec = [] } = {}) {
  const perFile = new Map();
  const diff = gitText(['diff', '--no-color', '--no-ext-diff', '-U0', baseCommit, '--', ...pathspec], { cwd });
  for (const [path, lines] of changedLinesFromDiff(diff)) {
    if (isXliff(path, xliffGlobs)) continue;
    const found = extractIds(lines, patterns);
    if (found.size) perFile.set(path, found);
  }
  if (includeUntracked) {
    const untracked = gitText(['ls-files', '-z', '--others', '--exclude-standard', '--', ...pathspec], { cwd });
    for (const path of untracked.split('\0').filter(Boolean)) {
      if (isXliff(path, xliffGlobs)) continue;
      let content;
      try {
        content = readFileSync(join(cwd, path), 'utf8');
      } catch {
        continue;
      }
      const found = extractIds(content.split(/\r?\n/), patterns);
      if (found.size) perFile.set(path, found);
    }
  }
  const all = new Set();
  for (const ids of perFile.values()) for (const id of ids) all.add(id);
  return { ids: all, perFile };
}

// ----------------------------------------------------------------- XLIFF units

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e];
  });
}

export function parseUnits(content) {
  const units = [];
  for (const m of content.matchAll(UNIT_RE)) {
    const idMatch = ID_ATTR_RE.exec(m.groups.attrs);
    if (!idMatch) continue;
    units.push({
      id: unescapeXml(idMatch[1] ?? idMatch[2]),
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
    });
  }
  return units;
}

/** Return `staged` with the units whose id is in `ids` taken from `worktree`. */
export function mergeUnits(staged, worktree, ids) {
  const sUnits = parseUnits(staged);
  const wUnits = parseUnits(worktree);
  const sById = new Map(sUnits.map((u) => [u.id, u]));
  const wById = new Map(wUnits.map((u) => [u.id, u]));
  const result = { content: staged, changed: [], added: [], removed: [] };

  const replace = new Map();
  const remove = new Set();
  const insertAfter = new Map(); // anchor id in staged file -> blocks; null = before first unit

  for (const id of ids) {
    const s = sById.get(id);
    const w = wById.get(id);
    if (s && w) {
      if (s.text !== w.text) {
        replace.set(id, w.text);
        result.changed.push(id);
      }
    } else if (s) {
      remove.add(id);
      result.removed.push(id);
    }
  }

  let anchor = null;
  for (const u of wUnits) {
    if (sById.has(u.id)) {
      anchor = u.id;
    } else if (ids.has(u.id)) {
      if (!insertAfter.has(anchor)) insertAfter.set(anchor, []);
      insertAfter.get(anchor).push(u.text);
      result.added.push(u.id);
    }
  }
  result.changed.sort();
  result.removed.sort();
  result.touched = result.changed.length + result.added.length + result.removed.length;
  if (!result.touched) return result;

  const out = [];
  if (sUnits.length) {
    let pos = 0;
    sUnits.forEach((u, i) => {
      out.push(staged.slice(pos, u.start));
      if (i === 0 && insertAfter.has(null)) out.push(...insertAfter.get(null));
      if (!remove.has(u.id)) out.push(replace.get(u.id) ?? u.text);
      out.push(...(insertAfter.get(u.id) ?? []));
      pos = u.end;
    });
    out.push(staged.slice(pos));
  } else {
    const m = CONTAINER_END_RE.exec(staged);
    if (!m) throw new HelperError('no units and no </body>/</file> found to insert new units into');
    out.push(staged.slice(0, m.index), ...(insertAfter.get(null) ?? []), staged.slice(m.index));
  }
  result.content = out.join('');
  return result;
}

// --------------------------------------------------------------------- staging

/** Decode file bytes; returns { text, encode } where encode(text) gives bytes in the same format. */
export function decode(buf, path) {
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return {
      text: buf.subarray(2).toString('utf16le'),
      encode: (t) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')]),
    };
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.from(buf.subarray(2));
    le.swap16();
    return {
      text: le.toString('utf16le'),
      encode: (t) => {
        const b = Buffer.from(t, 'utf16le');
        b.swap16();
        return Buffer.concat([Buffer.from([0xfe, 0xff]), b]);
      },
    };
  }
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? buf.subarray(3) : buf);
  } catch {
    throw new HelperError(`${path}: cannot decode file (expected UTF-8 or UTF-16 with BOM)`);
  }
  return {
    text,
    encode: (t) => (bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(t, 'utf8')]) : Buffer.from(t, 'utf8')),
  };
}

function modifiedXliffFiles(cwd, globs) {
  const out = gitText(['diff', '--name-only', '-z', '--diff-filter=M'], { cwd });
  return out.split('\0').filter((p) => p && isXliff(p, globs));
}

function indexEntry(cwd, path) {
  const mode = gitText(['ls-files', '-s', '--', path], { cwd }).split(' ', 1)[0];
  return { mode, data: git(['show', `:${path}`], { cwd }) };
}

function stageContent(cwd, path, mode, data) {
  const sha = gitText(['hash-object', '-w', '--stdin'], { cwd, input: data }).trim();
  git(['update-index', '--cacheinfo', `${mode},${sha},${path}`], { cwd });
}

/** Minimal unified diff for --dry-run output (line-based LCS, fine for XLIFF-sized files). */
export function unifiedDiff(path, before, after, context = 3) {
  const a = before.split(/(?<=\n)/);
  const b = after.split(/(?<=\n)/);
  // Trim common prefix/suffix so the LCS table stays small.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const dp = Array.from({ length: am.length + 1 }, () => new Uint32Array(bm.length + 1));
  for (let i = am.length - 1; i >= 0; i--)
    for (let j = bm.length - 1; j >= 0; j--)
      dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  for (let k = 0; k < pre; k++) ops.push([' ', a[k]]);
  let i = 0;
  let j = 0;
  while (i < am.length || j < bm.length) {
    if (i < am.length && j < bm.length && am[i] === bm[j]) ops.push([' ', am[i++]]), j++;
    else if (i < am.length && (j >= bm.length || dp[i + 1][j] >= dp[i][j + 1])) ops.push(['-', am[i++]]);
    else ops.push(['+', bm[j++]]);
  }
  for (let k = a.length - suf; k < a.length; k++) ops.push([' ', a[k]]);

  const lines = [`--- a/${path} (staged)\n`, `+++ b/${path} (would be staged)\n`];
  const changes = ops.map((o, k) => (o[0] !== ' ' ? k : -1)).filter((k) => k >= 0);
  let idx = 0;
  while (idx < changes.length) {
    let start = Math.max(0, changes[idx] - context);
    let end = changes[idx];
    while (idx < changes.length && changes[idx] <= end + 2 * context) end = changes[idx++];
    end = Math.min(ops.length, end + context + 1);
    let aLine = 1;
    let bLine = 1;
    for (let k = 0; k < start; k++) {
      if (ops[k][0] !== '+') aLine++;
      if (ops[k][0] !== '-') bLine++;
    }
    const hunk = ops.slice(start, end);
    const aLen = hunk.filter((o) => o[0] !== '+').length;
    const bLen = hunk.filter((o) => o[0] !== '-').length;
    lines.push(`@@ -${aLine},${aLen} +${bLine},${bLen} @@\n`);
    for (const [op, text] of hunk) lines.push(op + (text.endsWith('\n') ? text : text + '\n'));
  }
  return lines.join('');
}

// ------------------------------------------------------------------------- CLI

const HELP = `Usage: xliff-stage [options]

Stage only the XLIFF translation units whose i18n IDs appear in your changes
(current branch + uncommitted work, compared to a base branch).

Options:
  -b, --base <branch>     branch to diff against (default: main; falls back to origin/<base>)
  -p, --pattern <regex>   regex finding an i18n ID in a changed line; first capture
                          group is the ID. Repeatable. Default: '@@([A-Za-z0-9_.\\-]+)'
      --id <id>           also stage this unit ID (repeatable)
      --xliff <glob>      glob for translation files (repeatable). Default: *.xlf *.xliff *.xlf2
      --source <path>     limit the ID scan to these source paths (git pathspec, repeatable)
      --no-untracked      do not scan untracked source files for IDs
  -n, --dry-run           show what would be staged without touching the index
      --list-ids          only print the IDs found in the changes, grouped by file
  -q, --quiet             print only errors
  -C <path>               run as if started in <path>
  -h, --help              show this help
      --version           show the version
`;

/**
 * Run the CLI. Returns the exit code.
 * @param {string[]} argv
 * @param {{ out?: (s: string) => void, err?: (s: string) => void }} io
 */
export function run(argv = process.argv.slice(2), { out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n') } = {}) {
  let args;
  try {
    ({ values: args } = parseArgs({
      args: argv,
      options: {
        base: { type: 'string', short: 'b', default: 'main' },
        pattern: { type: 'string', short: 'p', multiple: true },
        id: { type: 'string', multiple: true, default: [] },
        xliff: { type: 'string', multiple: true },
        source: { type: 'string', multiple: true, default: [] },
        'no-untracked': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', short: 'n', default: false },
        'list-ids': { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        C: { type: 'string', short: 'C', default: '.' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    err(`xliff-stage: ${e.message}\n\n${HELP}`);
    return 2;
  }
  if (args.help) return out(HELP), 0;
  if (args.version) return out(`xliff-stage ${VERSION}`), 0;
  const say = (s = '') => !args.quiet && out(s);

  let root;
  try {
    root = gitText(['rev-parse', '--show-toplevel'], { cwd: args.C }).trim();
  } catch {
    err('xliff-stage: not inside a git repository');
    return 2;
  }

  let patterns;
  try {
    patterns = (args.pattern ?? DEFAULT_ID_PATTERNS).map((p) => new RegExp(p, 'g'));
  } catch (e) {
    err(`xliff-stage: invalid --pattern: ${e.message}`);
    return 2;
  }
  const globs = args.xliff ?? DEFAULT_XLIFF_GLOBS;

  try {
    const baseCommit = resolveBase(args.base, root);
    const { ids, perFile } = collectIds(root, baseCommit, patterns, globs, {
      includeUntracked: !args['no-untracked'],
      pathspec: args.source,
    });
    for (const id of args.id) ids.add(id);

    if (args['list-ids']) {
      for (const path of [...perFile.keys()].sort()) {
        out(path);
        for (const id of [...perFile.get(path)].sort()) out(`  ${id}`);
      }
      if (args.id.length) {
        out('(--id)');
        for (const id of [...new Set(args.id)].sort()) out(`  ${id}`);
      }
      return 0;
    }

    const short = baseCommit.slice(0, 8);
    if (!ids.size) {
      say(`No i18n IDs found in changes since ${args.base} (${short}). Nothing staged.`);
      return 0;
    }
    say(`Found ${ids.size} i18n ID(s) in changes since ${args.base} (${short}).`);

    const files = modifiedXliffFiles(root, globs);
    if (!files.length) {
      say('No modified (unstaged) XLIFF files.');
      return 0;
    }

    let total = 0;
    for (const path of files) {
      const { mode, data } = indexEntry(root, path);
      const staged = decode(data, path);
      const work = decode(readFileSync(join(root, path)), path);
      const res = mergeUnits(staged.text, work.text, ids);
      if (!res.touched) {
        say(`  ${path}: no matching units changed`);
        continue;
      }
      total += res.touched;
      const summary = [['changed', res.changed], ['added', res.added], ['removed', res.removed]]
        .filter(([, l]) => l.length)
        .map(([k, l]) => `${l.length} ${k}`)
        .join(', ');
      say(`  ${path}: ${summary}`);
      if (args['dry-run']) say(unifiedDiff(path, staged.text, res.content).replace(/\n$/, ''));
      else stageContent(root, path, mode, staged.encode(res.content));
    }
    say(`${args['dry-run'] ? 'Would stage' : 'Staged'} ${total} unit(s). Other XLIFF changes are left unstaged.`);
    return 0;
  } catch (e) {
    if (!(e instanceof HelperError)) throw e;
    err(`xliff-stage: ${e.message}`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = run();
