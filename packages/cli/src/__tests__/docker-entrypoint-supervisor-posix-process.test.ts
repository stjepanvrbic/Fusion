// @vitest-environment node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasLiveSupervisingParent } from "../commands/dashboard.js";
import {
  RECORDING_STUB,
  entrypoint,
  entrypointShell,
  installStubCli,
  makeRoot,
  readRuns,
  removeRoots,
  runEntrypoint,
  waitForFile,
} from "./_docker-entrypoint-fixture.js";

/*
FNXC:DockerSourceUpdate 2026-10-08-15:05:
KB-061: these two docker-entrypoint invariants depend on the Linux process model the container runs under, so they were moved verbatim out of docker-entrypoint-supervisor.test.ts into this file.
On a win32 host (Git Bash/MSYS) they are undefined, not broken: a native node child launched by the MSYS shell as a background job sees `process.ppid` equal to an intermediate MSYS stub, neither the supervisor's MSYS `$$` nor its `/proc/$$/winpid`, and Node cannot deliver SIGTERM on Windows (`child.kill("SIGTERM")` is TerminateProcess, so the trap never runs).
No skip or platform gate is applied: the Windows lane ledgers exactly this file (evidence in the KB-061 `windows-residual` task document), while Linux CI keeps both assertions binding.
*/

afterEach(() => {
  removeRoots();
});

describe("docker entrypoint restart supervisor (POSIX process model)", () => {
  it("stamps a supervisor pid that the dashboard's own supervision check accepts", async () => {
    const root = makeRoot();
    installStubCli(root, RECORDING_STUB);
    const record = join(root, "runs.jsonl");

    await runEntrypoint([], {
      FUSION_APP_ROOT: root,
      STUB_RECORD_FILE: record,
      STUB_EXIT_CODES: JSON.stringify([0]),
    });

    const [run] = readRuns(record);
    expect(run.supervisedFlag).toBe("1");
    // The stamp must be the child's REAL parent: hasLiveSupervisingParent rejects a merely inherited
    // flag, so a supervisor that stamps someone else's pid leaves restartSupported false.
    expect(run.supervisorPid).toBe(String(run.realPpid));
    expect(
      hasLiveSupervisingParent(
        { FUSION_RESTART_SUPERVISED: run.supervisedFlag, FUSION_SUPERVISOR_PID: run.supervisorPid },
        run.realPpid,
      ),
    ).toBe(true);
  });

  it("forwards SIGTERM to the child and exits with the child's own status", async () => {
    const root = makeRoot();
    const ready = join(root, "ready");
    const signalled = join(root, "signalled");
    // FNXC:DockerSourceUpdate 2026-10-08-15:05: KB-061 — the stub self-exits after 60 s so a host that cannot deliver SIGTERM (win32) does not leak an immortal node process; the test settles long before that.
    installStubCli(
      root,
      `
import { writeFileSync } from "node:fs";
setTimeout(() => process.exit(3), 60_000);
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(signalled)}, "term"); process.exit(0); });
writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1000);
`,
    );

    const child = execFile(entrypointShell, [entrypoint], { env: { ...process.env, FUSION_APP_ROOT: root } });
    const exited = new Promise<number>((resolvePromise) => {
      child.on("exit", (code) => resolvePromise(code ?? -1));
    });
    await waitForFile(ready);
    child.kill("SIGTERM");

    // 0, not 143: the supervisor waits for the child's real status rather than reporting the signal
    // that interrupted its own `wait`, so `docker stop` records a graceful shutdown.
    expect(await exited).toBe(0);
    expect(existsSync(signalled)).toBe(true);
  });
});
