#!/usr/bin/env python3
"""Convert ThreatCrush terminal output to SARIF 2.1.0, and filter known fixtures.

Two modes:

* Convert (``--input``/``--output``): the compatibility shim described below.
* Filter (``--filter-sarif PATH --repo-root DIR``): rewrites a SARIF file in
  place, removing only results that match the reviewed ``KNOWN_FIXTURES``
  allow-list. It runs on every SARIF the workflow produces (native or
  converted), so it is the single suppression seam. A result is suppressed
  only when its rule id, its exact repository-relative path, and the actual
  source line in the checkout all match one entry; anything ambiguous is kept.
  Malformed SARIF exits 2 without rewriting the file. Suppressions are
  recorded in ``runs[i].properties["fusion/knownFixtureSuppressions"]``.
  Optional ``--fail-on`` is evaluated on the remaining results.

  Adding an entry requires an exact rule id, an exact path, a full-line regex
  that pins the whole credential value, and a one-line reason, reviewed in a
  pull request.

Convert mode:

Compatibility shim for CLI versions older than native ``--format sarif``.
When the CLI can emit SARIF itself the workflow uses that and never runs this
file; parsing a human-readable stream is strictly worse and exists only so a
repository is not left unscanned while waiting for a release.

It **fails closed**. If it cannot recognise the output it exits non-zero and
dumps what it saw. Emitting empty SARIF instead would report "0 findings",
which is indistinguishable from a clean scan and is the single most expensive
thing a security tool can get wrong.

Three details of the format, each of which is load-bearing:

* Severity is bare for ``CRITICAL`` and bracketed for ``[HIGH]``/``[MEDIUM]``/
  ``[LOW]``. One regex shape misses half the findings.
* ``File:`` paths are relative to the scan root, not the repository root. Left
  unprefixed, every finding resolves to nothing in the consumer's view of the
  repo. Hence ``--path-prefix``.
* Whole-file findings report line ``:0``. SARIF requires ``startLine >= 1``.

``Code:`` lines are redacted excerpts of the match. They are skipped rather
than parsed, both because matching them would double-count every finding and
because a redacted excerpt tells a reader nothing the ``Info:`` line does not.
"""

from __future__ import annotations

import argparse
import copy
import fnmatch
import json
import os
import re
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import NamedTuple

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

# `   CRITICAL  AWS Access Key`  /  `  [HIGH] Sensitive File`
SEVERITY_LINE = re.compile(r"^\s*(?:\[(CRITICAL|HIGH|MEDIUM|LOW|INFO)\]|(CRITICAL))\s+(.+?)\s*$")
FILE_LINE = re.compile(r"^\s*File:\s*(.+?):(\d+)\s*$")
INFO_LINE = re.compile(r"^\s*Info:\s*(.+?)\s*$")

# Proof that a scan ran to completion. Without one of these we are looking at a
# crash, a help screen, or an unrecognised release — never at a clean result.
#
# FNXC:ThreatCrushFooter 2026-08-24-02:14:
# The last non-empty line must full-match a documented completion footer.
# `match()` plus `.*No security issues found` accepted any line that merely
# contained the phrase — a truncated crash quoting the clean message then
# produced empty SARIF and a green check. ThreatCrush 0.11.0 `printHuman()`
# emits `✓ No security issues found!` or `N issue(s) found across M files`.
# Optional bang / missing checkmark stay accepted; `--fail-on` trailer lines
# are skipped so a requested failure cannot look like an unrecognised scan.
FOOTER = re.compile(
    r"\s*(?:✓\s+No security issues found!|No security issues found!?|"
    r"(?P<count>\d+)\s+issue\(s\)\s+found(?:\s+across\s+\d+\s+files)?)\s*"
)
_FAIL_ON_TRAILER = re.compile(r"^\s*✗\s+findings at or above\b")

LEVELS = {"CRITICAL": "error", "HIGH": "error", "MEDIUM": "warning", "LOW": "note", "INFO": "none"}
SECURITY_SEVERITY = {"CRITICAL": "9.0", "HIGH": "7.0", "MEDIUM": "5.0", "LOW": "3.0", "INFO": "1.0"}
RANK = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


class Unrecognised(Exception):
    """The output did not look like a completed ThreatCrush scan."""


def rule_id(title: str) -> str:
    """Derive a stable rule id from a finding title.

    Old CLIs print `AWS Access Key`, not `secret-aws-access-key`. Slugifying
    keeps SARIF results groupable and keeps fingerprints stable across runs,
    which is what stops the Security tab treating every run as brand-new alerts.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return f"threatcrush-{slug}" if slug else "threatcrush-finding"


def _completion_line(lines: list[str]) -> str:
    for line in reversed(lines):
        if not line.strip() or _FAIL_ON_TRAILER.match(line):
            continue
        return line
    return ""


def parse(text: str) -> list[dict]:
    lines = ANSI.sub("", text).splitlines()
    footer = FOOTER.fullmatch(_completion_line(lines))
    if footer is None:
        raise Unrecognised("no scan-completion footer found")
    # "No security issues found" has no number; that branch means zero.
    expected = int(footer.group("count") or 0)

    findings: list[dict] = []
    pending: dict | None = None

    for line in lines:
        severity_match = SEVERITY_LINE.match(line)
        if severity_match:
            # FNXC:ThreatCrushParse 2026-08-24-02:14:
            # A later severity used to overwrite `pending`. An incomplete
            # earlier block then vanished, and if the remaining complete
            # findings happened to match the footer count the converter
            # reported a successful under-count. Fail closed before replace.
            if pending is not None:
                raise Unrecognised(
                    f"incomplete finding block: {pending.get('title', 'untitled')!r}"
                )
            severity = severity_match.group(1) or severity_match.group(2)
            pending = {"severity": severity.upper(), "title": severity_match.group(3).strip()}
            continue

        if pending is None:
            continue

        file_match = FILE_LINE.match(line)
        if file_match:
            pending["file"] = file_match.group(1).strip()
            pending["line"] = int(file_match.group(2))
            continue

        info_match = INFO_LINE.match(line)
        if info_match and "file" in pending:
            pending["message"] = info_match.group(1).strip()
            findings.append(pending)
            pending = None

    # Fail closed on a trailing half-read block. Mid-scan overwrites are
    # rejected at the next severity line so they cannot be laundered by a
    # later complete finding that happens to match the footer count.
    if pending is not None:
        raise Unrecognised(f"incomplete finding block: {pending.get('title', 'untitled')!r}")
    if len(findings) != expected:
        raise Unrecognised(f"footer reported {expected} finding(s), parsed {len(findings)}")

    return findings


def to_sarif(findings: list[dict], prefix: str, version: str) -> dict:
    rules: dict[str, dict] = {}
    results = []

    for finding in findings:
        rid = rule_id(finding["title"])
        rules.setdefault(
            rid,
            {
                "id": rid,
                "name": rid,
                "shortDescription": {"text": finding["title"]},
                "fullDescription": {"text": finding["title"]},
                "defaultConfiguration": {"level": LEVELS[finding["severity"]]},
                "properties": {
                    "tags": ["security", "threatcrush"],
                    "security-severity": SECURITY_SEVERITY[finding["severity"]],
                },
            },
        )

        # removeprefix, not lstrip. lstrip takes a *set* of characters, so
        # lstrip("./") eats every leading dot and slash: `.github/workflows/x.yml`
        # became `github/workflows/x.yml` and `.env` became `env`. Both then point
        # at a path that does not exist, and `.env` is exactly the sort of file a
        # credential scanner has findings in.
        uri = finding["file"].removeprefix("./")
        if prefix:
            uri = f"{prefix.strip('/')}/{uri}"

        results.append(
            {
                "ruleId": rid,
                "level": LEVELS[finding["severity"]],
                "message": {"text": finding.get("message", finding["title"])},
                "locations": [
                    {
                        "physicalLocation": {
                            "artifactLocation": {"uri": uri, "uriBaseId": "%SRCROOT%"},
                            # Clamped: SARIF rejects 0, and a whole-file finding
                            # has no line to report.
                            "region": {"startLine": max(1, finding["line"])},
                        }
                    }
                ],
                "partialFingerprints": {
                    "primaryLocationLineHash": f"{rid}:{uri}:{max(1, finding['line'])}"
                },
                "properties": {"severity": finding["severity"].lower()},
            }
        )

    return {
        "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
        "version": "2.1.0",
        "runs": [
            {
                "tool": {
                    "driver": {
                        "name": "ThreatCrush",
                        "version": version,
                        "informationUri": "https://threatcrush.com",
                        "rules": list(rules.values()),
                    }
                },
                "results": results,
                "columnKind": "utf16CodeUnits",
            }
        ],
    }


# FNXC:ThreatCrushAllowList 2026-10-08-04:53:
# The PR scan reported four non-secrets (CI Postgres defaults and a test placeholder token) as high-severity code-scanning alerts.
# The allow-list must quiet exactly those known fixtures while a real secret — even in the same file, or a changed value on an allow-listed line — is still uploaded and still fails the check.
# Matching is line-exact against the checkout: SARIF snippets are redacted (`FUS****: "run-token"`) so they cannot tell a placeholder from a real key, and the `threatcrush/contentHash/v1` fingerprint is opaque, so neither is trusted.
# `threatcrush scan --exclude` and `.threatcrushignore` were rejected: they exclude whole paths, which would hide any future real secret added to those files.
# Every entry pins the full credential value (no `.*` around it) and needs a reviewed one-line reason; never add path-only, rule-only, or directory-wide entries.
# Suppression fails closed: any unreadable, unsafe, or ambiguous location keeps the finding.


class KnownFixture(NamedTuple):
    """One reviewed allow-list entry. All three of rule, path, and line must match."""

    id: str
    rules: frozenset[str]
    # Exact repo-relative POSIX paths (fnmatchcase patterns are tolerated, but exact is preferred).
    paths: tuple[str, ...]
    # Each pattern is applied with fullmatch to the stripped source line.
    lines: tuple[re.Pattern[str], ...]
    reason: str


KNOWN_FIXTURES: tuple[KnownFixture, ...] = (
    KnownFixture(
        id="ci-postgres-service-default",
        rules=frozenset({"secret-database-url", "secret-generic-credential"}),
        paths=(".github/workflows/full-suite.yml", ".github/workflows/pr-checks.yml"),
        lines=(
            re.compile(r'FUSION_PG_TEST_URL_BASE: "postgresql://postgres:(?:postgres|root)@localhost:5432"'),
            re.compile(r'PGPASSWORD: "(?:postgres|root)"'),
        ),
        reason=(
            "GitHub Windows runner preinstalled PostgreSQL (postgres/root) and Linux service-container "
            "default (postgres/postgres); localhost-only throwaway test databases."
        ),
    ),
    KnownFixture(
        id="ci-workflow-test-postgres-assertion",
        rules=frozenset({"secret-database-url"}),
        paths=("packages/cli/src/__tests__/ci-workflow.test.ts",),
        lines=(
            re.compile(
                r'expect\(job\?\.env\?\.FUSION_PG_TEST_URL_BASE\)\.toBe\('
                r'"postgresql://postgres:(?:postgres|root)@localhost:5432"\);'
            ),
        ),
        reason="Test asserting the CI workflow's localhost Postgres default URL.",
    ),
    KnownFixture(
        id="live-provider-run-token-placeholder",
        rules=frozenset({"secret-generic-credential"}),
        paths=("packages/core/src/__tests__/live-provider-credential-scrub.test.ts",),
        lines=(re.compile(r'FUSION_TEST_RUN_TOKEN: "run-token",?'),),
        reason="Placeholder token used to prove credential scrubbing; not a real credential.",
    ),
)

SUPPRESSIONS_KEY = "fusion/knownFixtureSuppressions"
_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


class InvalidSarif(Exception):
    """The SARIF document is not shaped well enough to filter safely."""


def _safe_relative_uri(uri: object) -> str | None:
    """Return the uri if it is a plain relative POSIX path, else None (keep the result)."""
    if not isinstance(uri, str) or not uri:
        return None
    if _SCHEME.match(uri) or ":" in uri or "\\" in uri or "%" in uri:
        return None
    if uri.startswith("/"):
        return None
    parts = PurePosixPath(uri).parts
    if any(part in ("..", ".") for part in uri.split("/")) or not parts:
        return None
    return uri


class _SourceLines:
    """Reads checkout files once, as strict UTF-8, refusing anything outside the repo root."""

    def __init__(self, repo_root: Path) -> None:
        self.root = Path(repo_root).resolve()
        self._cache: dict[str, list[str] | None] = {}

    def line(self, uri: str, number: object) -> str | None:
        if not isinstance(number, int) or isinstance(number, bool) or number < 1:
            return None
        if uri not in self._cache:
            self._cache[uri] = self._read(uri)
        lines = self._cache[uri]
        if lines is None or number > len(lines):
            return None
        return lines[number - 1]

    def _read(self, uri: str) -> list[str] | None:
        try:
            path = (self.root / uri).resolve()
            path.relative_to(self.root)
            if not path.is_file():
                return None
            text = path.read_bytes().decode("utf-8")
        except (OSError, ValueError, UnicodeDecodeError):
            return None
        # Split on "\n" only: splitlines() also breaks on form feeds and U+2028,
        # which would shift numbering away from the scanner's line numbers.
        lines = text.split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        return [line.rstrip("\r") for line in lines]


def _location_matches(location: object, fixture: KnownFixture, source: _SourceLines) -> tuple[str, int] | None:
    if not isinstance(location, dict):
        return None
    physical = location.get("physicalLocation")
    if not isinstance(physical, dict):
        return None
    artifact = physical.get("artifactLocation")
    region = physical.get("region")
    if not isinstance(artifact, dict) or not isinstance(region, dict):
        return None
    if artifact.get("uriBaseId", "%SRCROOT%") != "%SRCROOT%":
        return None
    uri = _safe_relative_uri(artifact.get("uri"))
    if uri is None or not any(fnmatch.fnmatchcase(uri, pattern) for pattern in fixture.paths):
        return None
    start = region.get("startLine")
    end = region.get("endLine", start)
    if end != start:
        # A multi-line match may cover more than the allow-listed line.
        return None
    text = source.line(uri, start)
    if text is None:
        return None
    stripped = text.strip()
    if not any(pattern.fullmatch(stripped) for pattern in fixture.lines):
        return None
    return uri, start


def _match_fixture(result: dict, fixtures, source: _SourceLines) -> dict | None:
    rid = result.get("ruleId")
    locations = result.get("locations")
    if not isinstance(rid, str) or not isinstance(locations, list) or not locations:
        return None
    for fixture in fixtures:
        if rid not in fixture.rules:
            continue
        matched = [_location_matches(loc, fixture, source) for loc in locations]
        if all(m is not None for m in matched):
            uri, start = matched[0]
            return {"fixtureId": fixture.id, "ruleId": rid, "uri": uri, "startLine": start}
    return None


def _validate(sarif: object) -> None:
    if not isinstance(sarif, dict):
        raise InvalidSarif("top level is not an object")
    runs = sarif.get("runs")
    if not isinstance(runs, list):
        raise InvalidSarif("missing or non-list `runs`")
    for index, run in enumerate(runs):
        if not isinstance(run, dict):
            raise InvalidSarif(f"runs[{index}] is not an object")
        results = run.get("results")
        if not isinstance(results, list):
            raise InvalidSarif(f"runs[{index}].results is missing or not a list")
        if not all(isinstance(result, dict) for result in results):
            raise InvalidSarif(f"runs[{index}].results contains a non-object")
        properties = run.get("properties", {})
        if not isinstance(properties, dict):
            raise InvalidSarif(f"runs[{index}].properties is not an object")


def filter_known_fixtures(sarif: dict, repo_root: Path, fixtures=KNOWN_FIXTURES) -> tuple[dict, list[dict]]:
    """Return (filtered copy, suppression records). Raises InvalidSarif on malformed input.

    Per-result problems never raise: they keep the result. `tool.driver.rules` is untouched.
    """
    _validate(sarif)
    filtered = copy.deepcopy(sarif)
    source = _SourceLines(repo_root)
    suppressions: list[dict] = []
    for run in filtered["runs"]:
        kept: list[dict] = []
        run_suppressions: list[dict] = []
        for result in run["results"]:
            record = _match_fixture(result, fixtures, source)
            if record is None:
                kept.append(result)
            else:
                run_suppressions.append(record)
        run["results"] = kept
        if run_suppressions:
            properties = run.setdefault("properties", {})
            existing = properties.get(SUPPRESSIONS_KEY)
            properties[SUPPRESSIONS_KEY] = (existing if isinstance(existing, list) else []) + run_suppressions
        suppressions.extend(run_suppressions)
    return filtered, suppressions


def _parse_thresholds(fail_on: str) -> tuple[list[str], list[str]]:
    thresholds = [s.strip().lower() for s in fail_on.split(",") if s.strip()]
    return thresholds, [s for s in thresholds if s not in RANK]


def _filter_main(path: str, repo_root: str, fail_on: str) -> int:
    thresholds, unknown = _parse_thresholds(fail_on)
    if unknown:
        print(f"error: unknown severity in --fail-on: {', '.join(unknown)}", file=sys.stderr)
        return 2
    try:
        with open(path, encoding="utf-8") as handle:
            sarif = json.load(handle)
        filtered, suppressions = filter_known_fixtures(sarif, Path(repo_root))
    except (OSError, ValueError, InvalidSarif) as err:
        # Fail closed: never rewrite, never let an unfilterable file read as clean.
        print(f"error: cannot filter SARIF {path}: {err}", file=sys.stderr)
        return 2

    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".threatcrush-filter-", suffix=".sarif", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(filtered, handle, indent=2)
            handle.write("\n")
        os.replace(tmp, path)
    except OSError as err:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        print(f"error: cannot write filtered SARIF {path}: {err}", file=sys.stderr)
        return 2

    for record in suppressions:
        print(f"suppressed known fixture {record['fixtureId']} {record['ruleId']} {record['uri']}:{record['startLine']}")
    remaining = sum(len(run["results"]) for run in filtered["runs"])
    print(f"suppressed {len(suppressions)} known fixture result(s); {remaining} result(s) remain")

    if thresholds:
        floor = min(RANK[s] for s in thresholds)
        for run in filtered["runs"]:
            for result in run["results"]:
                properties = result.get("properties")
                severity = properties.get("severity") if isinstance(properties, dict) else None
                rank = RANK.get(severity.lower()) if isinstance(severity, str) else None
                # An unknown severity counts as a breach: guessing low would open the gate.
                if rank is None or rank >= floor:
                    print(f"::error::findings at or above {fail_on}")
                    return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="convert mode: captured `threatcrush scan` output")
    parser.add_argument("--output", help="convert mode: SARIF file to write")
    parser.add_argument("--path-prefix", default="", help="prepended to every file URI")
    parser.add_argument("--tool-version", default="unknown")
    parser.add_argument("--fail-on", default="", help="comma-separated severities that exit 1")
    parser.add_argument("--filter-sarif", help="filter mode: SARIF file to filter in place")
    parser.add_argument("--repo-root", default=".", help="filter mode: checkout the SARIF uris are relative to")
    args = parser.parse_args()

    convert_mode = args.input is not None or args.output is not None
    if convert_mode and args.filter_sarif is not None:
        parser.error("use either --filter-sarif or --input/--output, not both")
    if args.filter_sarif is not None:
        return _filter_main(args.filter_sarif, args.repo_root, args.fail_on)
    if args.input is None or args.output is None:
        parser.error("convert mode requires both --input and --output (or use --filter-sarif)")

    with open(args.input, encoding="utf-8", errors="replace") as handle:
        text = handle.read()

    try:
        findings = parse(text)
    except Unrecognised as err:
        print(f"error: unrecognised ThreatCrush output ({err})", file=sys.stderr)
        print("--- first 40 lines ---", file=sys.stderr)
        for line in ANSI.sub("", text).splitlines()[:40]:
            print(line, file=sys.stderr)
        return 2

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(to_sarif(findings, args.path_prefix, args.tool_version), handle, indent=2)
        handle.write("\n")

    print(f"converted {len(findings)} finding(s) to {args.output}")

    thresholds, unknown = _parse_thresholds(args.fail_on)
    if thresholds:
        if unknown:
            # Silently ignoring a typo produces a gate that never fires, which
            # looks exactly like a passing build.
            print(f"error: unknown severity in --fail-on: {', '.join(unknown)}", file=sys.stderr)
            return 2
        floor = min(RANK[s] for s in thresholds)
        if any(RANK[f["severity"].lower()] >= floor for f in findings):
            print(f"::error::findings at or above {args.fail_on}")
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
