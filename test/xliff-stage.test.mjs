// Tests for xliff-stage.mjs. Run with: npm test
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as xs from '../xliff-stage.mjs';

const XLF12 = `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en" target-language="de" datatype="plaintext" original="ng2.template">
    <body>
      <trans-unit id="home.title" datatype="html">
        <source>Home</source>
        <target>Startseite</target>
      </trans-unit>
      <trans-unit id="cart.title" datatype="html">
        <source>Cart</source>
        <target>Warenkorb</target>
      </trans-unit>
      <trans-unit id="footer.legal" datatype="html">
        <source>Legal</source>
        <target>Impressum</target>
      </trans-unit>
    </body>
  </file>
</xliff>
`;

const XLF20 = `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="2.0" xmlns="urn:oasis:names:tc:xliff:document:2.0" srcLang="en" trgLang="de">
  <file id="ngi18n" original="ng.template">
    <unit id="home.title">
      <segment>
        <source>Home</source>
        <target>Startseite</target>
      </segment>
    </unit>
    <unit id="cart.title">
      <segment>
        <source>Cart</source>
        <target>Warenkorb</target>
      </segment>
    </unit>
  </file>
</xliff>
`;

const unit12 = (id, s, t) =>
  `      <trans-unit id="${id}" datatype="html">\n        <source>${s}</source>\n        <target>${t}</target>\n      </trans-unit>\n`;

describe('mergeUnits', () => {
  test('stages a changed unit only', () => {
    const work = XLF12.replace('Warenkorb', 'Einkaufswagen').replace('Impressum', 'Rechtliches');
    const res = xs.mergeUnits(XLF12, work, new Set(['cart.title']));
    assert.deepEqual(res.changed, ['cart.title']);
    assert.match(res.content, /Einkaufswagen/);
    assert.match(res.content, /Impressum/);
    assert.doesNotMatch(res.content, /Rechtliches/);
  });

  test('inserts an added unit after the preceding unit', () => {
    const anchor = '      <trans-unit id="footer.legal"';
    const work = XLF12.replace(anchor, unit12('cart.empty', 'Empty', 'Leer') + unit12('other.new', 'X', 'Y') + anchor);
    const res = xs.mergeUnits(XLF12, work, new Set(['cart.empty']));
    assert.deepEqual(res.added, ['cart.empty']);
    assert.doesNotMatch(res.content, /other\.new/);
    assert.ok(res.content.indexOf('cart.title') < res.content.indexOf('cart.empty'));
    assert.ok(res.content.indexOf('cart.empty') < res.content.indexOf('footer.legal'));
    assert.equal(xs.mergeUnits(res.content, work, new Set(['other.new'])).content, work);
  });

  test('inserts an added unit at the start', () => {
    const work = XLF12.replace('      <trans-unit id="home.title"', unit12('aaa.first', 'A', 'A') + '      <trans-unit id="home.title"');
    assert.equal(xs.mergeUnits(XLF12, work, new Set(['aaa.first'])).content, work);
  });

  test('removes a unit', () => {
    const block = unit12('cart.title', 'Cart', 'Warenkorb');
    assert.ok(XLF12.includes(block));
    const work = XLF12.replace(block, '');
    const res = xs.mergeUnits(XLF12, work.replace('Impressum', 'X'), new Set(['cart.title']));
    assert.deepEqual(res.removed, ['cart.title']);
    assert.equal(res.content, work);
  });

  test('adds into a file without units', () => {
    const empty = XLF12.split('    <body>\n')[0] + '    <body>\n    </body>\n  </file>\n</xliff>\n';
    const work = empty.replace('    </body>', unit12('a.b', 'A', 'B') + '    </body>');
    assert.equal(xs.mergeUnits(empty, work, new Set(['a.b'])).content, work);
  });

  test('handles XLIFF 2.0', () => {
    const work = XLF20.replace('Warenkorb', 'Einkaufswagen').replace('Startseite', 'Start');
    const res = xs.mergeUnits(XLF20, work, new Set(['cart.title']));
    assert.deepEqual(res.changed, ['cart.title']);
    assert.match(res.content, /Einkaufswagen/);
    assert.match(res.content, /Startseite/);
    assert.deepEqual(xs.parseUnits(XLF20).map((u) => u.id), ['home.title', 'cart.title']);
  });

  test('unescapes ids and accepts single quotes', () => {
    const c = "<body>\n  <trans-unit id='a&amp;b'><source>x</source></trans-unit>\n</body>";
    assert.deepEqual(xs.parseUnits(c).map((u) => u.id), ['a&b']);
  });

  test('no match leaves content untouched', () => {
    const res = xs.mergeUnits(XLF12, XLF12.replace('Warenkorb', 'X'), new Set(['unknown']));
    assert.equal(res.touched, 0);
    assert.equal(res.content, XLF12);
  });

  test('preserves CRLF', () => {
    const staged = XLF12.replaceAll('\n', '\r\n');
    const work = staged.replace('Warenkorb', 'Korb').replace('Impressum', 'X');
    assert.equal(xs.mergeUnits(staged, work, new Set(['cart.title'])).content, staged.replace('Warenkorb', 'Korb'));
  });
});

describe('ID extraction', () => {
  test('default pattern covers Angular custom IDs', () => {
    const pats = xs.DEFAULT_ID_PATTERNS.map((p) => new RegExp(p, 'g'));
    const ids = xs.extractIds([
      '<h1 i18n="site header|An introduction header@@introductionHeader">Hello</h1>',
      '<img i18n-title="@@logo.title" title="Logo">',
      'const t = $localize`:meaning|desc@@checkout.button-label:Pay now`;',
      '<p i18n>no id here</p>',
    ], pats);
    assert.deepEqual([...ids].sort(), ['checkout.button-label', 'introductionHeader', 'logo.title']);
  });

  test('diff parsing includes added, removed and deleted files', () => {
    const diff = [
      'diff --git a/src/a.html b/src/a.html', '--- a/src/a.html', '+++ b/src/a.html', '@@ -1 +1 @@',
      '-<p i18n="@@old.id">Old</p>', '+<p i18n="@@new.id">New</p>',
      'diff --git a/src/gone.html b/src/gone.html', 'deleted file mode 100644', '--- a/src/gone.html',
      '+++ /dev/null', '@@ -1 +0,0 @@', '-<p i18n="@@gone.id">Gone</p>', '',
    ].join('\n');
    const lines = xs.changedLinesFromDiff(diff);
    assert.deepEqual([...lines.keys()].sort(), ['src/a.html', 'src/gone.html']);
    assert.equal(lines.get('src/a.html').length, 2);
  });

  test('isXliff globs', () => {
    assert.ok(xs.isXliff('src/locale/messages.de.xlf', xs.DEFAULT_XLIFF_GLOBS));
    assert.ok(!xs.isXliff('src/app.html', xs.DEFAULT_XLIFF_GLOBS));
  });
});

describe('decode', () => {
  test('round-trips UTF-8 BOM and UTF-16', () => {
    for (const buf of [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ä<x/>')]),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ä<x/>', 'utf16le')]),
    ]) {
      const d = xs.decode(buf, 'f');
      assert.equal(d.text, 'ä<x/>');
      assert.deepEqual(d.encode(d.text), buf);
    }
  });
});

describe('git end-to-end', () => {
  let repo;
  const g = (...args) => execFileSync('git', args, { cwd: repo }).toString();
  const write = (rel, c) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), c);
  };
  const read = (rel) => readFileSync(join(repo, rel), 'utf8');
  const staged = (rel) => g('show', `:${rel}`);
  const runTool = (...args) => {
    const lines = [];
    const code = xs.run(['-C', repo, ...args], { out: (s) => lines.push(s), err: (s) => lines.push(s) });
    return { code, out: lines.join('\n') };
  };
  const translate = () => {
    for (const [name, word] of [['de', 'Einkaufswagen'], ['fr', 'Panier']]) {
      const rel = `src/locale/messages.${name}.xlf`;
      write(rel, read(rel).replace('Warenkorb', word).replace('Impressum', `LEGAL-${name}`).replace('Startseite', `HOME-${name}`));
    }
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'xliff-stage-'));
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'Test');
    g('config', 'core.autocrlf', 'false');
    write('src/app.html', '<h1 i18n="@@home.title">Home</h1>\n');
    write('src/locale/messages.de.xlf', XLF12);
    write('src/locale/messages.fr.xlf', XLF12.replace('target-language="de"', 'target-language="fr"'));
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    g('checkout', '-q', '-b', 'feature');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('stages only units from committed branch changes', () => {
    write('src/cart.html', '<h2 i18n="Cart heading@@cart.title">Cart</h2>\n');
    g('add', 'src/cart.html');
    g('commit', '-q', '-m', 'cart');
    translate();
    const { code, out } = runTool();
    assert.equal(code, 0, out);
    for (const [name, word] of [['de', 'Einkaufswagen'], ['fr', 'Panier']]) {
      const s = staged(`src/locale/messages.${name}.xlf`);
      assert.match(s, new RegExp(word));
      assert.doesNotMatch(s, /LEGAL-|HOME-/);
      assert.match(read(`src/locale/messages.${name}.xlf`), new RegExp(`LEGAL-${name}`));
    }
    assert.match(g('diff', '--name-only'), /messages\.de\.xlf/);
  });

  test('uncommitted and untracked source changes count', () => {
    write('src/app.html', '<h1 i18n="@@home.title">Home!</h1>\n');
    write('src/new.html', '<p i18n="@@footer.legal">Legal</p>\n');
    translate();
    assert.equal(runTool().code, 0);
    let s = staged('src/locale/messages.de.xlf');
    assert.match(s, /HOME-de/);
    assert.match(s, /LEGAL-de/);
    assert.match(s, /Warenkorb/);
    g('reset', '-q');
    runTool('--no-untracked');
    s = staged('src/locale/messages.de.xlf');
    assert.match(s, /HOME-de/);
    assert.doesNotMatch(s, /LEGAL-de/);
  });

  test('dry run does not touch the index', () => {
    write('src/cart.html', '<h2 i18n="@@cart.title">Cart</h2>\n');
    translate();
    const { code, out } = runTool('--dry-run');
    assert.equal(code, 0);
    assert.match(out, /^\+        <target>Einkaufswagen<\/target>$/m);
    assert.match(out, /^-        <target>Warenkorb<\/target>$/m);
    assert.equal(g('diff', '--cached', '--name-only'), '');
  });

  test('is idempotent', () => {
    write('src/cart.html', '<h2 i18n="@@cart.title">Cart</h2>\n');
    translate();
    runTool();
    const first = staged('src/locale/messages.de.xlf');
    const { code, out } = runTool();
    assert.equal(code, 0);
    assert.equal(staged('src/locale/messages.de.xlf'), first);
    assert.match(out, /no matching units changed/);
  });

  test('XLIFF changes themselves do not provide IDs', () => {
    translate();
    const { out } = runTool();
    assert.match(out, /No i18n IDs found/);
    assert.equal(g('diff', '--cached', '--name-only'), '');
  });

  test('--list-ids and --id', () => {
    write('src/cart.html', '<h2 i18n="@@cart.title">Cart</h2>\n');
    const { code, out } = runTool('--list-ids', '--id', 'manual.id');
    assert.equal(code, 0);
    assert.match(out, /src\/cart\.html\n  cart\.title/);
    assert.match(out, /manual\.id/);
  });

  test('--id stages a unit', () => {
    translate();
    runTool('--id', 'footer.legal');
    const s = staged('src/locale/messages.de.xlf');
    assert.match(s, /LEGAL-de/);
    assert.match(s, /Warenkorb/);
  });

  test('custom pattern', () => {
    write('src/cart.ts', "this.t('cart.title')\n");
    translate();
    runTool('--pattern', "this\\.t\\('([^']+)'\\)");
    assert.match(staged('src/locale/messages.de.xlf'), /Einkaufswagen/);
  });

  test('--base and missing base', () => {
    assert.equal(runTool('--base', 'does-not-exist').code, 1);
    g('checkout', '-q', '-b', 'develop');
    write('src/cart.html', '<h2 i18n="@@cart.title">Cart</h2>\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'develop work');
    g('checkout', '-q', '-b', 'feature2');
    translate();
    assert.match(runTool('--base', 'develop').out, /No i18n IDs found/);
    runTool('--base', 'main');
    assert.match(staged('src/locale/messages.de.xlf'), /Einkaufswagen/);
  });

  test('keeps previously staged content', () => {
    write('src/cart.html', '<h2 i18n="@@cart.title">Cart</h2>\n');
    translate();
    write('tmp.xlf', XLF12.replace('Startseite', 'MANUAL'));
    const sha = g('hash-object', '-w', 'tmp.xlf').trim();
    unlinkSync(join(repo, 'tmp.xlf'));
    g('update-index', '--cacheinfo', `100644,${sha},src/locale/messages.de.xlf`);
    runTool();
    const s = staged('src/locale/messages.de.xlf');
    assert.match(s, /MANUAL/);
    assert.match(s, /Einkaufswagen/);
  });

  test('XLIFF 2.0 end to end', () => {
    write('src/locale/messages.de.xlf2', XLF20);
    g('add', '-A');
    g('commit', '-q', '-m', 'xliff2');
    write('src/cart.html', '<h2 i18n="@@cart.title">Cart</h2>\n');
    write('src/locale/messages.de.xlf2', XLF20.replace('Warenkorb', 'Korb').replace('Startseite', 'NOPE'));
    const { code, out } = runTool();
    assert.equal(code, 0, out);
    const s = staged('src/locale/messages.de.xlf2');
    assert.match(s, /Korb/);
    assert.doesNotMatch(s, /NOPE/);
  });
});
