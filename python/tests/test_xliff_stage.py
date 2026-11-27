"""Tests for xliff_stage. Run with: cd python && python3 -m unittest discover -s tests"""

import io
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import xliff_stage as xs  # noqa: E402


XLF12_BASE = textwrap.dedent("""\
    <?xml version="1.0" encoding="UTF-8" ?>
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
    """)

XLF20_BASE = textwrap.dedent("""\
    <?xml version="1.0" encoding="UTF-8" ?>
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
    """)


def unit12(uid, source, target):
    return (f'      <trans-unit id="{uid}" datatype="html">\n'
            f'        <source>{source}</source>\n'
            f'        <target>{target}</target>\n'
            f'      </trans-unit>\n')


class MergeUnitsTest(unittest.TestCase):
    def test_changed_unit_only(self):
        work = XLF12_BASE.replace("Warenkorb", "Einkaufswagen").replace("Impressum", "Rechtliches")
        res = xs.merge_units(XLF12_BASE, work, {"cart.title"})
        self.assertEqual(res.changed, ["cart.title"])
        self.assertIn("Einkaufswagen", res.content)
        self.assertIn("Impressum", res.content)
        self.assertNotIn("Rechtliches", res.content)

    def test_added_unit_inserted_after_previous_unit(self):
        new = unit12("cart.empty", "Empty", "Leer")
        other = unit12("other.new", "X", "Y")
        anchor = "      </trans-unit>\n      <trans-unit id=\"footer.legal\""
        work = XLF12_BASE.replace(anchor, "      </trans-unit>\n" + new + other + anchor[len("      </trans-unit>\n"):], 1)
        res = xs.merge_units(XLF12_BASE, work, {"cart.empty"})
        self.assertEqual(res.added, ["cart.empty"])
        self.assertNotIn("other.new", res.content)
        self.assertLess(res.content.index("cart.title"), res.content.index("cart.empty"))
        self.assertLess(res.content.index("cart.empty"), res.content.index("footer.legal"))
        # Staging the remaining id too must reproduce the working tree exactly.
        self.assertEqual(xs.merge_units(res.content, work, {"other.new"}).content, work)

    def test_added_unit_at_start(self):
        new = unit12("aaa.first", "A", "A")
        work = XLF12_BASE.replace('      <trans-unit id="home.title"', new + '      <trans-unit id="home.title"', 1)
        res = xs.merge_units(XLF12_BASE, work, {"aaa.first"})
        self.assertEqual(res.content, work)

    def test_removed_unit(self):
        block = unit12("cart.title", "Cart", "Warenkorb")
        self.assertIn(block, XLF12_BASE)
        work = XLF12_BASE.replace(block, "")
        res = xs.merge_units(XLF12_BASE, work.replace("Impressum", "X"), {"cart.title"})
        self.assertEqual(res.removed, ["cart.title"])
        self.assertEqual(res.content, work)

    def test_no_units_in_staged_file(self):
        empty = XLF12_BASE.split("    <body>\n")[0] + "    <body>\n    </body>\n  </file>\n</xliff>\n"
        work = empty.replace("    </body>", unit12("a.b", "A", "B") + "    </body>")
        res = xs.merge_units(empty, work, {"a.b"})
        self.assertEqual(res.content, work)

    def test_xliff20_units(self):
        work = XLF20_BASE.replace("Warenkorb", "Einkaufswagen").replace("Startseite", "Start")
        res = xs.merge_units(XLF20_BASE, work, {"cart.title"})
        self.assertEqual(res.changed, ["cart.title"])
        self.assertIn("Einkaufswagen", res.content)
        self.assertIn("Startseite", res.content)

    def test_xliff20_segment_and_group_not_confused(self):
        content = XLF20_BASE.replace('<file id="ngi18n"', '<file id="ngi18n"')
        ids = [u.id for u in xs.parse_units(content)]
        self.assertEqual(ids, ["home.title", "cart.title"])

    def test_escaped_and_single_quoted_ids(self):
        content = "<body>\n  <trans-unit id='a&amp;b'><source>x</source></trans-unit>\n</body>"
        self.assertEqual([u.id for u in xs.parse_units(content)], ["a&b"])

    def test_nothing_matches(self):
        work = XLF12_BASE.replace("Warenkorb", "X")
        res = xs.merge_units(XLF12_BASE, work, {"unknown.id"})
        self.assertEqual(res.touched, 0)
        self.assertEqual(res.content, XLF12_BASE)

    def test_crlf_preserved(self):
        staged = XLF12_BASE.replace("\n", "\r\n")
        work = staged.replace("Warenkorb", "Korb").replace("Impressum", "X")
        res = xs.merge_units(staged, work, {"cart.title"})
        self.assertEqual(res.content, staged.replace("Warenkorb", "Korb"))


class IdExtractionTest(unittest.TestCase):
    def test_default_pattern(self):
        pats = [__import__("re").compile(p) for p in xs.DEFAULT_ID_PATTERNS]
        lines = [
            '<h1 i18n="site header|An introduction header@@introductionHeader">Hello</h1>',
            '<img i18n-title="@@logo.title" title="Logo">',
            "const t = $localize`:meaning|desc@@checkout.button-label:Pay now`;",
            "<p i18n>no id here</p>",
        ]
        self.assertEqual(xs.extract_ids(lines, pats),
                         {"introductionHeader", "logo.title", "checkout.button-label"})

    def test_diff_parsing_includes_added_and_removed(self):
        diff = textwrap.dedent("""\
            diff --git a/src/a.html b/src/a.html
            --- a/src/a.html
            +++ b/src/a.html
            @@ -1 +1 @@
            -<p i18n="@@old.id">Old</p>
            +<p i18n="@@new.id">New</p>
            diff --git a/src/gone.html b/src/gone.html
            deleted file mode 100644
            --- a/src/gone.html
            +++ /dev/null
            @@ -1 +0,0 @@
            -<p i18n="@@gone.id">Gone</p>
            """)
        lines = xs.changed_lines_from_diff(diff)
        self.assertEqual(set(lines), {"src/a.html", "src/gone.html"})
        self.assertEqual(len(lines["src/a.html"]), 2)


class GitRepoTest(unittest.TestCase):
    """End-to-end tests against a throwaway git repository."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = self.tmp.name
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "Test")
        self.git("config", "core.autocrlf", "false")
        self.write("src/app.html", '<h1 i18n="@@home.title">Home</h1>\n')
        self.write("src/locale/messages.de.xlf", XLF12_BASE)
        self.write("src/locale/messages.fr.xlf", XLF12_BASE.replace('target-language="de"', 'target-language="fr"'))
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "base")
        self.git("checkout", "-q", "-b", "feature")

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode()

    def write(self, rel, content):
        path = os.path.join(self.repo, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", newline="") as fh:
            fh.write(content)

    def read(self, rel):
        with open(os.path.join(self.repo, rel), newline="") as fh:
            return fh.read()

    def run_tool(self, *args):
        out = io.StringIO()
        code = xs.run(["-C", self.repo, *args], out=out)
        return code, out.getvalue()

    def staged(self, rel):
        return self.git("show", f":{rel}")

    def simulate_translation_tool(self):
        """Change many units, like a re-import from the translation tool would."""
        for name, word in (("de", "Einkaufswagen"), ("fr", "Panier")):
            rel = f"src/locale/messages.{name}.xlf"
            content = self.read(rel)
            content = content.replace("Warenkorb", word).replace("Impressum", "LEGAL-" + name)
            content = content.replace("Startseite", "HOME-" + name)
            self.write(rel, content)

    def test_stages_only_units_from_committed_branch_changes(self):
        self.write("src/cart.html", '<h2 i18n="Cart heading@@cart.title">Cart</h2>\n')
        self.git("add", "src/cart.html")
        self.git("commit", "-q", "-m", "cart")
        self.simulate_translation_tool()

        code, out = self.run_tool()
        self.assertEqual(code, 0, out)
        for name, word in (("de", "Einkaufswagen"), ("fr", "Panier")):
            staged = self.staged(f"src/locale/messages.{name}.xlf")
            self.assertIn(word, staged)
            self.assertNotIn("LEGAL-", staged)
            self.assertNotIn("HOME-", staged)
            # The working tree is untouched.
            self.assertIn("LEGAL-" + name, self.read(f"src/locale/messages.{name}.xlf"))
        # Unrelated changes remain as unstaged modifications.
        self.assertIn("messages.de.xlf", self.git("diff", "--name-only"))

    def test_uncommitted_and_untracked_source_changes_count(self):
        self.write("src/app.html", '<h1 i18n="@@home.title">Home!</h1>\n')  # modified, unstaged
        self.write("src/new.html", '<p i18n="@@footer.legal">Legal</p>\n')   # untracked
        self.simulate_translation_tool()
        code, out = self.run_tool()
        self.assertEqual(code, 0, out)
        staged = self.staged("src/locale/messages.de.xlf")
        self.assertIn("HOME-de", staged)
        self.assertIn("LEGAL-de", staged)
        self.assertIn("Warenkorb", staged)

        self.git("reset", "-q")
        code, out = self.run_tool("--no-untracked")
        staged = self.staged("src/locale/messages.de.xlf")
        self.assertIn("HOME-de", staged)
        self.assertNotIn("LEGAL-de", staged)

    def test_dry_run_does_not_touch_index(self):
        self.write("src/cart.html", '<h2 i18n="@@cart.title">Cart</h2>\n')
        self.simulate_translation_tool()
        code, out = self.run_tool("--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("+        <target>Einkaufswagen</target>", out)
        self.assertEqual(self.git("diff", "--cached", "--name-only"), "")

    def test_idempotent(self):
        self.write("src/cart.html", '<h2 i18n="@@cart.title">Cart</h2>\n')
        self.simulate_translation_tool()
        self.run_tool()
        first = self.staged("src/locale/messages.de.xlf")
        code, out = self.run_tool()
        self.assertEqual(code, 0)
        self.assertEqual(first, self.staged("src/locale/messages.de.xlf"))
        self.assertIn("no matching units changed", out)

    def test_xliff_changes_themselves_do_not_provide_ids(self):
        self.simulate_translation_tool()
        code, out = self.run_tool()
        self.assertEqual(code, 0)
        self.assertIn("No i18n IDs found", out)
        self.assertEqual(self.git("diff", "--cached", "--name-only"), "")

    def test_list_ids_and_extra_id(self):
        self.write("src/cart.html", '<h2 i18n="@@cart.title">Cart</h2>\n')
        code, out = self.run_tool("--list-ids", "--id", "manual.id")
        self.assertEqual(code, 0)
        self.assertIn("src/cart.html\n  cart.title", out)
        self.assertIn("manual.id", out)

    def test_extra_id_stages_unit(self):
        self.simulate_translation_tool()
        self.run_tool("--id", "footer.legal")
        self.assertIn("LEGAL-de", self.staged("src/locale/messages.de.xlf"))
        self.assertIn("Warenkorb", self.staged("src/locale/messages.de.xlf"))

    def test_custom_pattern(self):
        self.write("src/cart.ts", "this.t('cart.title')\n")
        self.simulate_translation_tool()
        self.run_tool("--pattern", r"this\.t\('([^']+)'\)")
        self.assertIn("Einkaufswagen", self.staged("src/locale/messages.de.xlf"))

    def test_base_branch_option_and_missing_base(self):
        code, _ = self.run_tool("--base", "does-not-exist")
        self.assertEqual(code, 1)

        self.git("checkout", "-q", "-b", "develop")
        self.write("src/cart.html", '<h2 i18n="@@cart.title">Cart</h2>\n')
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "develop work")
        self.git("checkout", "-q", "-b", "feature2")
        self.simulate_translation_tool()
        # Against develop, the cart change is not part of this branch.
        code, out = self.run_tool("--base", "develop")
        self.assertIn("No i18n IDs found", out)
        code, out = self.run_tool("--base", "main")
        self.assertIn("Einkaufswagen", self.staged("src/locale/messages.de.xlf"))

    def test_keeps_previously_staged_units(self):
        self.write("src/cart.html", '<h2 i18n="@@cart.title">Cart</h2>\n')
        self.simulate_translation_tool()
        # Something was staged by hand before running the tool.
        manual = XLF12_BASE.replace("Startseite", "MANUAL")
        self.write("tmp.xlf", manual)
        sha = self.git("hash-object", "-w", "tmp.xlf").strip()
        os.remove(os.path.join(self.repo, "tmp.xlf"))
        self.git("update-index", "--cacheinfo", f"100644,{sha},src/locale/messages.de.xlf")
        self.run_tool()
        staged = self.staged("src/locale/messages.de.xlf")
        self.assertIn("MANUAL", staged)
        self.assertIn("Einkaufswagen", staged)

    def test_xliff20_end_to_end(self):
        self.write("src/locale/messages.de.xlf2", XLF20_BASE)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "xliff2")
        self.write("src/cart.html", '<h2 i18n="@@cart.title">Cart</h2>\n')
        self.write("src/locale/messages.de.xlf2",
                   XLF20_BASE.replace("Warenkorb", "Korb").replace("Startseite", "NOPE"))
        code, out = self.run_tool()
        self.assertEqual(code, 0, out)
        staged = self.staged("src/locale/messages.de.xlf2")
        self.assertIn("Korb", staged)
        self.assertNotIn("NOPE", staged)


if __name__ == "__main__":
    unittest.main()
