import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/*
FNXC:TestInfraWindows 2026-10-07-18:04:
Test fixtures build real git repositories. Shell command strings (`git commit -m 'msg'`, `&&` chains, `mkdir -p`) only parse under a POSIX shell, so on Windows they failed under cmd.exe before the test body ran.
Fixtures pass argv to git through this helper instead: no shell is involved, so quoting is identical on every platform. The async exec seam is deliberately not rerouted to bash, because product code under test uses it too.
*/
export interface GitFixtureOptions {
  env?: NodeJS.ProcessEnv;
}

/** Runs `git <args>` in `cwd` without a shell and returns trimmed stdout; throws with git's stderr on failure. */
export function gitFixtureSync(cwd: string, args: readonly string[], options: GitFixtureOptions = {}): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.env ? { env: options.env } : {}),
  }).trim();
}

/** Async form of {@link gitFixtureSync}. */
export async function gitFixture(cwd: string, args: readonly string[], options: GitFixtureOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    ...(options.env ? { env: options.env } : {}),
  });
  return stdout.trim();
}
