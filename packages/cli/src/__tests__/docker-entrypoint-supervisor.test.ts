// @vitest-environment node
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RECORDING_STUB, installStubCli, makeRoot, readRuns, removeRoots, runEntrypoint } from "./_docker-entrypoint-fixture.js";

/*
FNXC:DockerSourceUpdate 2026-09-01-01:22:
Behavioral coverage for the container entrypoint's restart supervisor. These run the REAL script
under `sh` against a stub CLI, because the invariants that matter are runtime ones no text assertion
can see: does exit 86 actually relaunch, does any other code actually reach the container, does the
child actually observe a supervisor pid that is its real parent (the thing hasLiveSupervisingParent
verifies before advertising restartSupported), and does --from-source actually refuse to silently
fall back to the image build.

FNXC:DockerSourceUpdate 2026-10-08-15:05:
KB-061: the script now runs through `resolvePosixShell()` (Git Bash on win32, `sh` elsewhere) via the shared fixture, so these portable invariants also hold on a Windows host.
The two invariants that depend on the Linux process model (the child's real parent pid and SIGTERM delivery) live in docker-entrypoint-supervisor-posix-process.test.ts.
*/

afterEach(() => {
  removeRoots();
});

describe("docker entrypoint restart supervisor", () => {
  it("relaunches the dashboard when it exits with the restart code and stops on the next clean exit", async () => {
    const root = makeRoot();
    installStubCli(root, RECORDING_STUB);
    const record = join(root, "runs.jsonl");

    const result = await runEntrypoint(["dashboard", "--host", "0.0.0.0"], {
      FUSION_APP_ROOT: join(root),
      STUB_RECORD_FILE: record,
      STUB_EXIT_CODES: JSON.stringify([86, 86, 0]),
    });

    expect(result.code).toBe(0);
    const runs = readRuns(record);
    expect(runs).toHaveLength(3);
    // Arguments survive every relaunch verbatim — a restart must not silently change how the
    // dashboard was launched.
    for (const run of runs) expect(run.argv).toEqual(["dashboard", "--host", "0.0.0.0"]);
  });

  it("propagates a non-restart exit code to the container instead of relaunching", async () => {
    const root = makeRoot();
    installStubCli(root, RECORDING_STUB);
    const record = join(root, "runs.jsonl");

    const result = await runEntrypoint([], {
      FUSION_APP_ROOT: root,
      STUB_RECORD_FILE: record,
      STUB_EXIT_CODES: JSON.stringify([7]),
    });

    expect(result.code).toBe(7);
    expect(readRuns(record)).toHaveLength(1);
  });
});

describe("docker entrypoint --from-source", () => {
  it("runs the source checkout's CLI and strips the flag from the CLI arguments", async () => {
    const appRoot = makeRoot();
    const sourceRoot = makeRoot();
    installStubCli(appRoot, "process.exit(66);");
    installStubCli(sourceRoot, RECORDING_STUB);
    const record = join(sourceRoot, "runs.jsonl");

    const result = await runEntrypoint(["--from-source", "dashboard", "--host", "0.0.0.0"], {
      FUSION_APP_ROOT: appRoot,
      FUSION_SOURCE_ROOT: sourceRoot,
      STUB_RECORD_FILE: record,
      STUB_EXIT_CODES: JSON.stringify([0]),
    });

    expect(result.code).toBe(0);
    const runs = readRuns(record);
    expect(runs).toHaveLength(1);
    expect(runs[0].argv).toEqual(["dashboard", "--host", "0.0.0.0"]);
  });

  it("accepts the env equivalent of the flag", async () => {
    const appRoot = makeRoot();
    const sourceRoot = makeRoot();
    installStubCli(appRoot, "process.exit(66);");
    installStubCli(sourceRoot, RECORDING_STUB);
    const record = join(sourceRoot, "runs.jsonl");

    const result = await runEntrypoint(["dashboard"], {
      FUSION_FROM_SOURCE: "1",
      FUSION_APP_ROOT: appRoot,
      FUSION_SOURCE_ROOT: sourceRoot,
      STUB_RECORD_FILE: record,
      STUB_EXIT_CODES: JSON.stringify([0]),
    });

    expect(result.code).toBe(0);
    expect(readRuns(record)).toHaveLength(1);
  });

  it("fails loudly instead of silently falling back to the image build when no source build exists", async () => {
    const appRoot = makeRoot();
    const sourceRoot = makeRoot();
    installStubCli(appRoot, RECORDING_STUB);
    const record = join(appRoot, "runs.jsonl");

    const result = await runEntrypoint(["--from-source", "dashboard"], {
      FUSION_APP_ROOT: appRoot,
      FUSION_SOURCE_ROOT: sourceRoot,
      STUB_RECORD_FILE: record,
      STUB_EXIT_CODES: JSON.stringify([0]),
    });

    expect(result.code).toBe(1);
    // The actionable part: it names the path it looked for and says it will not fall back.
    // The script prints `$FUSION_SOURCE_ROOT/packages/cli/dist/bin.js` verbatim (POSIX separators; identical to join() on Linux).
    expect(result.stderr).toContain(`${sourceRoot}/packages/cli/dist/bin.js`);
    expect(result.stderr).toMatch(/refusing to fall back/i);
    // And it really did not run the image build.
    expect(readRuns(record)).toHaveLength(0);
  });
});
