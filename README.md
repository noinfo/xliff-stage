# xliff-stage

Stage only the XLIFF translation units that belong to your branch's changes.

After importing from the translation tool (or running `ng extract-i18n`), the
`.xlf` files usually contain far more changes than your branch is about.
`xliff-stage` diffs your branch against a base branch (default `main`),
collects the i18n IDs on changed source lines, and stages only the matching
`<trans-unit>` (XLIFF 1.2) or `<unit>` (XLIFF 2.0) blocks. Every other XLIFF
change stays unstaged.

Two versions with identical behaviour, both single files without dependencies:

| Version | File | Needs |
| --- | --- | --- |
| Node | [`xliff-stage.mjs`](xliff-stage.mjs) | Node 20+, git |
| Python | [`python/xliff_stage.py`](python/xliff_stage.py) | Python 3.8+, git |

## Install

**In a Node/Angular project:** copy `xliff-stage.mjs` (and optionally
`test/xliff-stage.test.mjs`) into your `tools/` folder and add scripts to
`package.json`:

```json
{
  "scripts": {
    "i18n:stage": "node tools/xliff-stage.mjs",
    "test:tools": "node --test tools/*.test.mjs"
  }
}
```

If you copy the test file, change its import to `./xliff-stage.mjs`.

**Globally from this repo:**

```sh
npm install -g github:noinfo/xliff-stage   # provides the `xliff-stage` command
```

**As a personal script:**

```sh
cp python/xliff_stage.py ~/bin/xliff-stage && chmod +x ~/bin/xliff-stage
```

## Usage

```sh
xliff-stage                  # diff against main, stage matching units
xliff-stage -n               # dry run: show the diff that would be staged
xliff-stage -b develop       # use another base branch
xliff-stage --list-ids       # just show which IDs were found, per file
xliff-stage --id some.id     # also stage this unit (repeatable)
```

With the npm script, pass options after `--`, e.g. `npm run i18n:stage -- -n`.

Typical flow:

```sh
# 1. import translations from the tool (modifies many units)
# 2. stage what belongs to this branch
xliff-stage -n && xliff-stage
git commit -m "Translations for checkout"
git restore src/locale/      # drop the rest, if you don't want it
```

### Options

| Option | What it does |
| --- | --- |
| `-b, --base <branch>` | Branch to diff against. Default `main`, falls back to `origin/main`. |
| `-n, --dry-run` | Show the diff that would be staged without changing anything. |
| `--list-ids` | Print the IDs found in your changes, grouped by file. |
| `--id <id>` | Also stage this unit. Repeatable. |
| `-p, --pattern <regex>` | Custom ID pattern; the first capture group is the ID. Repeatable. |
| `--source <path>` | Only scan these source paths for IDs (git pathspec, repeatable). |
| `--xliff <glob>` | Translation file globs. Default `*.xlf`, `*.xliff`, `*.xlf2`. |
| `--no-untracked` | Ignore untracked source files. |
| `-q, --quiet` | Print only errors. |
| `-C <path>` | Run as if started in `<path>`. |

## What counts as "your changes"

Everything between the merge-base of `HEAD` and the base branch and your
working tree: commits on the branch, staged and unstaged edits, plus untracked
files. Both added and removed lines are scanned, so removing an `i18n`
attribute also stages the removal of its unit. XLIFF files themselves are
never scanned for IDs.

## How IDs are found

The default pattern `@@([A-Za-z0-9_.\-]+)` covers Angular's custom IDs:

```html
<h1 i18n="meaning|description@@checkout.title">Checkout</h1>
<img i18n-title="@@logo.title" title="Logo">
```
```ts
$localize`:meaning|description@@checkout.pay:Pay now`
```

Use `--pattern` for other conventions, e.g. `-p "translate\('([^']+)'\)"`.

Angular's auto-generated (hash) IDs can't be derived from source lines, so use
custom `@@` IDs or name units with `--id`.

## How staging works

For each XLIFF file with unstaged modifications, the tool starts from the
**staged** version, copies the matching units over from the working tree
(changed, newly added at the same position, or removed), and writes the result
to the index with `git update-index`. It never modifies the working tree, keeps
anything you staged before, and running it twice is a no-op. Line endings,
UTF-8 BOMs and UTF-16 files are preserved. Brand new, untracked XLIFF files
are skipped; add those with `git add`.

The Node module also exports its building blocks (`run`, `mergeUnits`,
`parseUnits`, `collectIds`, ...) for use from other build scripts.

## Tests

```sh
npm test              # Node version (node:test)
npm run test:python   # Python version (unittest)
```

Both suites create throwaway git repositories in the OS temp folder.
