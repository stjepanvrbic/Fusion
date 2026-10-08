#!/usr/bin/env python3
"""Behaviour tests for threatcrush-to-sarif.py.

FNXC:ThreatCrushParse 2026-08-24-02:14:
The converter is fail-closed. These cases pin the two review findings that
used to report a clean scan: a substring "footer" and an overwritten
incomplete finding block.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "threatcrush_to_sarif",
    Path(__file__).with_name("threatcrush-to-sarif.py"),
)
assert _SPEC and _SPEC.loader
_mod = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_mod)
parse = _mod.parse
Unrecognised = _mod.Unrecognised
filter_known_fixtures = _mod.filter_known_fixtures
InvalidSarif = _mod.InvalidSarif
SUPPRESSIONS_KEY = _mod.SUPPRESSIONS_KEY
SCRIPT = str(Path(__file__).with_name("threatcrush-to-sarif.py"))


CLEAN = """
Scanning . for security issues...
  ✓ No security issues found!
"""

FINDINGS = """
  Scan Results
  [HIGH] AWS Access Key
    File: .env:1
    Info: hardcoded credential
  1 issue(s) found across 12 files
"""


class ParseFooterTests(unittest.TestCase):
    def test_clean_scan_uses_documented_footer(self) -> None:
        self.assertEqual(parse(CLEAN), [])

    def test_findings_footer_with_across_files(self) -> None:
        findings = parse(FINDINGS)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["title"], "AWS Access Key")
        self.assertEqual(findings[0]["file"], ".env")

    def test_rejects_substring_footer_on_last_line(self) -> None:
        text = "error: failed to write cache: No security issues found in previous run\n"
        with self.assertRaises(Unrecognised):
            parse(text)

    def test_rejects_embedded_clean_phrase_when_last_line_is_not_footer(self) -> None:
        text = (
            "  [HIGH] AWS Access Key\n"
            "    File: .env:1\n"
            "    Info: hardcoded credential\n"
            "error: No security issues found in cache\n"
        )
        with self.assertRaises(Unrecognised):
            parse(text)

    def test_skips_fail_on_trailer_after_real_footer(self) -> None:
        text = CLEAN + "\n  ✗ findings at or above high — failing as requested by --fail-on\n"
        self.assertEqual(parse(text), [])


class ParseIncompleteBlockTests(unittest.TestCase):
    def test_rejects_incomplete_block_before_later_severity_overwrites_it(self) -> None:
        # Footer count would match the one complete finding if the incomplete
        # CRITICAL block were silently dropped.
        text = """
  CRITICAL  Incomplete Secret
  [HIGH] AWS Access Key
    File: .env:1
    Info: hardcoded credential
  1 issue(s) found across 12 files
"""
        with self.assertRaisesRegex(Unrecognised, "incomplete finding block"):
            parse(text)

    def test_rejects_trailing_incomplete_block(self) -> None:
        text = """
  [HIGH] AWS Access Key
    File: .env:1
  1 issue(s) found across 1 files
"""
        with self.assertRaisesRegex(Unrecognised, "incomplete finding block"):
            parse(text)


# FNXC:ThreatCrushAllowList 2026-10-08-04:53:
# PR #11 failed the ThreatCrush code-scanning check on four known fixtures.
# These tests pin that exactly those (and same-class CI Postgres defaults) are suppressed, while a real secret on another line of the same file, a changed value on an allow-listed line, a wrong rule, an unlisted file, or any unsafe location is kept.

FULL_SUITE = ".github/workflows/full-suite.yml"
CI_TEST = "packages/cli/src/__tests__/ci-workflow.test.ts"
SCRUB_TEST = "packages/core/src/__tests__/live-provider-credential-scrub.test.ts"

PG_ROOT_URL = '      FUSION_PG_TEST_URL_BASE: "postgresql://postgres:root@localhost:5432"'
PG_ASSERT = '    expect(job?.env?.FUSION_PG_TEST_URL_BASE).toBe("postgresql://postgres:root@localhost:5432");'
RUN_TOKEN = '      FUSION_TEST_RUN_TOKEN: "run-token",'


def write_source(root: Path, rel: str, lines: dict[int, str], total: int = 600) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    body = [lines.get(n, f"// filler line {n}") for n in range(1, total + 1)]
    path.write_text("\n".join(body) + "\n", encoding="utf-8")


def result(rule: str, uri: object, line: object, severity: str = "high", level: str = "error") -> dict:
    """Native ThreatCrush 0.11.0 result shape."""
    return {
        "ruleId": rule,
        "level": level,
        "message": {"text": "Hardcoded credential"},
        "locations": [
            {
                "physicalLocation": {
                    "artifactLocation": {"uri": uri, "uriBaseId": "%SRCROOT%"},
                    "region": {"startLine": line, "snippet": {"text": "FUS****************"}},
                }
            }
        ],
        "partialFingerprints": {"threatcrush/contentHash/v1": "abc123"},
        "properties": {"severity": severity, "confidence": "high", "category": "secret"},
    }


def sarif(results: list[dict], **run_extra) -> dict:
    run = {"tool": {"driver": {"name": "ThreatCrush", "rules": [{"id": "secret-database-url"}]}}, "results": results}
    run.update(run_extra)
    return {"version": "2.1.0", "runs": [run]}


class FilterKnownFixturesTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def run_filter(self, results: list[dict], **run_extra) -> tuple[dict, list[dict]]:
        return filter_known_fixtures(sarif(results, **run_extra), self.root)

    def write_reported_fixtures(self) -> None:
        write_source(
            self.root,
            FULL_SUITE,
            {336: PG_ROOT_URL, 400: '      DATABASE_URL: "postgresql://admin:hunter2@db.example.com:5432"'},
        )
        write_source(self.root, CI_TEST, {507: PG_ASSERT})
        write_source(
            self.root,
            SCRUB_TEST,
            {30: RUN_TOKEN, 54: RUN_TOKEN, 70: '      FUSION_TEST_RUN_TOKEN: "ghp_realLookingValue123",'},
        )

    def test_reported_four_findings_are_suppressed_and_real_secrets_remain(self) -> None:
        # Symptom verification for PR #11 (four non-secret alerts).
        self.write_reported_fixtures()
        reported = [
            result("secret-database-url", FULL_SUITE, 336),
            result("secret-database-url", CI_TEST, 507, level="note"),
            result("secret-generic-credential", SCRUB_TEST, 30, level="note"),
            result("secret-generic-credential", SCRUB_TEST, 54, level="note"),
        ]
        controls = [
            result("secret-generic-credential", SCRUB_TEST, 70, level="note"),
            result("secret-database-url", FULL_SUITE, 400),
        ]
        filtered, suppressions = self.run_filter(reported + controls)

        remaining = filtered["runs"][0]["results"]
        self.assertEqual(remaining, controls)
        for item in reported:
            self.assertNotIn(item, remaining)
        recorded = filtered["runs"][0]["properties"][SUPPRESSIONS_KEY]
        self.assertEqual(recorded, suppressions)
        self.assertEqual(
            [(r["fixtureId"], r["ruleId"], r["uri"], r["startLine"]) for r in recorded],
            [
                ("ci-postgres-service-default", "secret-database-url", FULL_SUITE, 336),
                ("ci-workflow-test-postgres-assertion", "secret-database-url", CI_TEST, 507),
                ("live-provider-run-token-placeholder", "secret-generic-credential", SCRUB_TEST, 30),
                ("live-provider-run-token-placeholder", "secret-generic-credential", SCRUB_TEST, 54),
            ],
        )
        # Rules stay; no credential material is recorded.
        self.assertEqual(filtered["runs"][0]["tool"]["driver"]["rules"], [{"id": "secret-database-url"}])
        self.assertNotIn('\"run-token\"', json.dumps(recorded))
        self.assertNotIn("postgres:root", json.dumps(recorded))

    def test_ci_service_container_defaults_are_suppressed(self) -> None:
        write_source(
            self.root,
            ".github/workflows/pr-checks.yml",
            {
                221: '      FUSION_PG_TEST_URL_BASE: "postgresql://postgres:postgres@localhost:5432"',
                222: '      PGPASSWORD: "postgres"',
            },
        )
        filtered, suppressions = self.run_filter(
            [
                result("secret-database-url", ".github/workflows/pr-checks.yml", 221),
                result("secret-generic-credential", ".github/workflows/pr-checks.yml", 222),
            ]
        )
        self.assertEqual(filtered["runs"][0]["results"], [])
        self.assertEqual(len(suppressions), 2)

    def test_changed_value_on_allow_listed_line_is_kept(self) -> None:
        write_source(
            self.root,
            FULL_SUITE,
            {
                336: '      FUSION_PG_TEST_URL_BASE: "postgresql://postgres:hunter2@localhost:5432"',
                337: '      PGPASSWORD: "hunter2"',
            },
        )
        write_source(self.root, SCRUB_TEST, {30: '      FUSION_TEST_RUN_TOKEN: "sk-live-0123456789abcdef",'})
        results = [
            result("secret-database-url", FULL_SUITE, 336),
            result("secret-generic-credential", FULL_SUITE, 337),
            result("secret-generic-credential", SCRUB_TEST, 30),
        ]
        filtered, suppressions = self.run_filter(results)
        self.assertEqual(filtered["runs"][0]["results"], results)
        self.assertEqual(suppressions, [])
        self.assertNotIn("properties", filtered["runs"][0])

    def test_fixture_literal_in_unlisted_file_is_kept(self) -> None:
        write_source(self.root, "packages/core/src/other.ts", {5: PG_ROOT_URL, 6: RUN_TOKEN})
        results = [
            result("secret-database-url", "packages/core/src/other.ts", 5),
            result("secret-generic-credential", "packages/core/src/other.ts", 6),
        ]
        filtered, suppressions = self.run_filter(results)
        self.assertEqual(filtered["runs"][0]["results"], results)
        self.assertEqual(suppressions, [])

    def test_wrong_rule_is_kept(self) -> None:
        self.write_reported_fixtures()
        results = [
            result("secret-openai-key", SCRUB_TEST, 30),
            result("secret-generic-credential", CI_TEST, 507),
        ]
        filtered, suppressions = self.run_filter(results)
        self.assertEqual(filtered["runs"][0]["results"], results)
        self.assertEqual(suppressions, [])

    def test_unsafe_or_unreadable_locations_are_kept(self) -> None:
        self.write_reported_fixtures()
        no_locations = result("secret-generic-credential", SCRUB_TEST, 30)
        no_locations["locations"] = []
        missing_locations = result("secret-generic-credential", SCRUB_TEST, 30)
        del missing_locations["locations"]
        multi_line = result("secret-generic-credential", SCRUB_TEST, 30)
        multi_line["locations"][0]["physicalLocation"]["region"]["endLine"] = 31
        mixed = result("secret-generic-credential", SCRUB_TEST, 30)
        mixed["locations"].append(result("secret-generic-credential", SCRUB_TEST, 70)["locations"][0])
        other_base = result("secret-generic-credential", SCRUB_TEST, 30)
        other_base["locations"][0]["physicalLocation"]["artifactLocation"]["uriBaseId"] = "OTHER"
        results = [
            result("secret-generic-credential", str((self.root / SCRUB_TEST).resolve()), 30),
            result("secret-generic-credential", "/" + SCRUB_TEST, 30),
            result("secret-generic-credential", "packages/core/../core/src/__tests__/live-provider-credential-scrub.test.ts", 30),
            result("secret-generic-credential", "../" + SCRUB_TEST, 30),
            result("secret-generic-credential", "file:///" + SCRUB_TEST, 30),
            result("secret-generic-credential", "./" + SCRUB_TEST, 30),
            result("secret-database-url", ".github/workflows/pr-checks.yml", 1),  # missing file
            result("secret-generic-credential", SCRUB_TEST, 0),
            result("secret-generic-credential", SCRUB_TEST, 601),
            result("secret-generic-credential", SCRUB_TEST, "30"),
            result("secret-generic-credential", None, 30),
            no_locations,
            missing_locations,
            multi_line,
            mixed,
            other_base,
        ]
        filtered, suppressions = self.run_filter(results)
        self.assertEqual(filtered["runs"][0]["results"], results)
        self.assertEqual(suppressions, [])

    def test_non_utf8_source_is_kept(self) -> None:
        path = self.root / SCRUB_TEST
        path.parent.mkdir(parents=True)
        path.write_bytes(b"\xff\xfe\n" + RUN_TOKEN.encode() + b"\n")
        results = [result("secret-generic-credential", SCRUB_TEST, 2)]
        filtered, _ = self.run_filter(results)
        self.assertEqual(filtered["runs"][0]["results"], results)

    def test_duplicate_lines_each_suppressed(self) -> None:
        write_source(self.root, SCRUB_TEST, {30: RUN_TOKEN, 54: RUN_TOKEN})
        filtered, suppressions = self.run_filter(
            [
                result("secret-generic-credential", SCRUB_TEST, 30),
                result("secret-generic-credential", SCRUB_TEST, 54),
                result("secret-generic-credential", SCRUB_TEST, 55),
            ]
        )
        self.assertEqual([r["startLine"] for r in suppressions], [30, 54])
        self.assertEqual(len(filtered["runs"][0]["results"]), 1)

    def test_empty_results_and_existing_run_properties_preserved(self) -> None:
        self.write_reported_fixtures()
        filtered, suppressions = self.run_filter([], properties={"keep": 1})
        self.assertEqual(suppressions, [])
        self.assertEqual(filtered["runs"][0], sarif([], properties={"keep": 1})["runs"][0])

        source = sarif([result("secret-generic-credential", SCRUB_TEST, 30)], properties={"keep": 1})
        filtered, _ = filter_known_fixtures(source, self.root)
        self.assertEqual(filtered["runs"][0]["properties"]["keep"], 1)
        self.assertEqual(len(filtered["runs"][0]["properties"][SUPPRESSIONS_KEY]), 1)
        # The input document is not mutated.
        self.assertEqual(len(source["runs"][0]["results"]), 1)
        self.assertNotIn(SUPPRESSIONS_KEY, source["runs"][0]["properties"])

    def test_malformed_documents_raise(self) -> None:
        for bad in ([], {}, {"runs": {}}, {"runs": [{}]}, {"runs": [{"results": {}}]}, {"runs": [{"results": [1]}]}):
            with self.subTest(bad=bad), self.assertRaises(InvalidSarif):
                filter_known_fixtures(bad, self.root)


class FilterCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        write_source(self.root, FULL_SUITE, {336: PG_ROOT_URL})
        write_source(self.root, CI_TEST, {507: PG_ASSERT})
        write_source(self.root, SCRUB_TEST, {30: RUN_TOKEN, 54: RUN_TOKEN})
        self.sarif_path = self.root / "threatcrush.sarif"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, SCRIPT, *args], capture_output=True, text=True, encoding="utf-8", check=False
        )

    def write_sarif(self, results: list[dict]) -> None:
        self.sarif_path.write_text(json.dumps(sarif(results)), encoding="utf-8")

    def filter(self, *extra: str) -> subprocess.CompletedProcess:
        return self.cli("--filter-sarif", str(self.sarif_path), "--repo-root", str(self.root), *extra)

    def read_results(self) -> list[dict]:
        return json.loads(self.sarif_path.read_text(encoding="utf-8"))["runs"][0]["results"]

    def test_reported_four_findings_are_suppressed_via_cli(self) -> None:
        control = result("secret-database-url", FULL_SUITE, 10)
        self.write_sarif(
            [
                result("secret-database-url", FULL_SUITE, 336),
                result("secret-database-url", CI_TEST, 507),
                result("secret-generic-credential", SCRUB_TEST, 30),
                result("secret-generic-credential", SCRUB_TEST, 54),
                control,
            ]
        )
        proc = self.filter()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.read_results(), [control])
        self.assertIn("suppressed 4 known fixture result(s); 1 result(s) remain", proc.stdout)
        self.assertIn(f"live-provider-run-token-placeholder secret-generic-credential {SCRUB_TEST}:54", proc.stdout)
        self.assertEqual([p.name for p in self.root.iterdir() if p.name.startswith(".threatcrush-filter-")], [])

    def test_malformed_json_fails_closed_without_rewrite(self) -> None:
        for content in (b"{not json", b'{"runs": 5}', b'{"version": "2.1.0"}'):
            with self.subTest(content=content):
                self.sarif_path.write_bytes(content)
                proc = self.filter()
                self.assertEqual(proc.returncode, 2)
                self.assertEqual(self.sarif_path.read_bytes(), content)

    def test_missing_file_fails_closed(self) -> None:
        proc = self.filter()
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(self.sarif_path.exists())

    def test_fail_on_only_counts_remaining_results(self) -> None:
        self.write_sarif([result("secret-generic-credential", SCRUB_TEST, 30, severity="high")])
        proc = self.filter("--fail-on", "high")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.read_results(), [])

        remaining = result("secret-generic-credential", SCRUB_TEST, 31, severity="high")
        self.write_sarif([result("secret-generic-credential", SCRUB_TEST, 30), remaining])
        proc = self.filter("--fail-on", "high")
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(self.read_results(), [remaining])

        low = result("secret-generic-credential", SCRUB_TEST, 31, severity="low")
        self.write_sarif([low])
        self.assertEqual(self.filter("--fail-on", "high").returncode, 0)

        unknown = result("secret-generic-credential", SCRUB_TEST, 31, severity="weird")
        self.write_sarif([unknown])
        self.assertEqual(self.filter("--fail-on", "high").returncode, 1)

    def test_unknown_fail_on_threshold_exits_2_without_rewrite(self) -> None:
        self.write_sarif([result("secret-generic-credential", SCRUB_TEST, 30)])
        before = self.sarif_path.read_bytes()
        self.assertEqual(self.filter("--fail-on", "hgih").returncode, 2)
        self.assertEqual(self.sarif_path.read_bytes(), before)

    def test_mode_selection_errors_exit_2(self) -> None:
        self.write_sarif([])
        self.assertEqual(self.cli().returncode, 2)
        self.assertEqual(self.cli("--input", "x").returncode, 2)
        both = self.cli("--filter-sarif", str(self.sarif_path), "--input", "x", "--output", "y")
        self.assertEqual(both.returncode, 2)


if __name__ == "__main__":
    unittest.main()
