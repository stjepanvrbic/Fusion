import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import {
  buildBashContainmentDenialMessage,
  evaluateBashContainment,
  normalizeBashCommandForContainment,
} from "../bash-containment.js";
import { wrapToolsWithBashContainment } from "../pi.js";

/*
FNXC:BashContainment 2026-07-26-14:00:
Regression tests for the unconditional privilege-escalation floor. The
incident chain was bash reading ~/.fusion/settings.json (daemon token) and
curling the approvals API to self-approve. Expectations are HARDCODED —
never derived from the rule table under test.
*/

describe("evaluateBashContainment — denies the escalation chain", () => {
  it("denies reading the global fusion settings file", () => {
    const verdict = evaluateBashContainment("cat ~/.fusion/settings.json");
    expect(verdict.allowed).toBe(false);
    expect(verdict.rule).toBe("fusion-global-dir");
  });

  it("denies quote-split spellings", () => {
    expect(evaluateBashContainment("cat ~/.fus''ion/settings.json").allowed).toBe(false);
    expect(evaluateBashContainment('cat "~/.fusion/settings.json"').allowed).toBe(false);
  });

  it("denies $HOME and ${HOME} spellings", () => {
    expect(evaluateBashContainment("cat $HOME/.fusion/settings.json").allowed).toBe(false);
    expect(evaluateBashContainment('cat "${HOME}/.fusion/settings.json"').allowed).toBe(false);
  });

  it("denies the literal home directory spelling", () => {
    expect(evaluateBashContainment(`cat ${homedir()}/.fusion/settings.json`).allowed).toBe(false);
  });

  it("denies other users' fusion dirs", () => {
    expect(evaluateBashContainment("cat /Users/someone/.fusion/settings.json").allowed).toBe(false);
    expect(evaluateBashContainment("cat /home/ci/.fusion/settings.json").allowed).toBe(false);
  });

  it("denies relative .fusion/settings.json reads", () => {
    expect(evaluateBashContainment("cd ~ && cat .fusion/settings.json").allowed).toBe(false);
  });

  it("denies daemon token env references", () => {
    expect(evaluateBashContainment("echo $FUSION_DAEMON_TOKEN").allowed).toBe(false);
    expect(evaluateBashContainment("env | grep -i daemonToken").allowed).toBe(false);
  });

  it("denies credential store reads", () => {
    expect(evaluateBashContainment("cat ~/.ssh/id_ed25519").allowed).toBe(false);
    expect(evaluateBashContainment("cat $HOME/.aws/credentials").allowed).toBe(false);
    expect(evaluateBashContainment("cat ~/.netrc").allowed).toBe(false);
    expect(evaluateBashContainment("cat ~/.npmrc").allowed).toBe(false);
    expect(evaluateBashContainment("cat ~/.config/gh/hosts.yml").allowed).toBe(false);
  });

  it("denies shell calls to the approvals API", () => {
    expect(
      evaluateBashContainment('curl -X POST http://localhost:4040/api/approvals/apr-123/decision -d \'{"decision":"approve"}\'').allowed,
    ).toBe(false);
    expect(evaluateBashContainment("curl 'http://127.0.0.1:9000/api/tasks?fn_token=abc'").allowed).toBe(false);
  });
});

/*
FNXC:BashContainment 2026-10-07-17:57:
The floor must deny the same targets in every path spelling native to the host OS.
Windows spellings (backslash, mixed separators, quoted, drive-letter case, %VAR%, $env:VAR, $USERPROFILE, MSYS /c/...) are exercised with an injected Windows home so the suite proves them on every CI platform.
*/
describe("evaluateBashContainment — Windows path spellings", () => {
  const homeDir = "C:\\Users\\Alice";
  const denied: Array<[string, string]> = [
    ["cat C:\\Users\\Alice\\.fusion\\settings.json", "fusion-global-dir"],
    ['cat "C:\\Users\\Alice\\.fusion\\settings.json"', "fusion-global-dir"],
    ["type c:\\users\\ALICE\\.fusion\\settings.json", "fusion-global-dir"],
    ["Get-Content C:/Users/Alice\\.fusion/settings.json", "fusion-global-dir"],
    ["cmd /c type %USERPROFILE%\\.fusion\\settings.json", "fusion-global-dir"],
    ["type %HOMEDRIVE%%HOMEPATH%\\.fusion\\settings.json", "fusion-global-dir"],
    ['cat "$USERPROFILE\\.fusion\\settings.json"', "fusion-global-dir"],
    ["Get-Content $env:USERPROFILE\\.fusion\\settings.json", "fusion-global-dir"],
    ["Get-Content ${env:USERPROFILE}\\.fusion\\settings.json", "fusion-global-dir"],
    ["cat /c/Users/Alice/.fusion/settings.json", "fusion-global-dir"],
    ["type D:\\Users\\Bob\\.fusion\\settings.json", "fusion-global-dir"],
    ["type .fusion\\settings.json", "fusion-settings-file"],
    ['cat "$USERPROFILE\\.ssh\\id_rsa"', "credential-store"],
    ["type C:\\Users\\Alice\\.aws\\credentials", "credential-store"],
    ["type %USERPROFILE%\\.npmrc", "credential-store"],
    ["type $env:USERPROFILE\\.config\\gh\\hosts.yml", "credential-store"],
    ["type C:\\Users\\Alice\\.docker\\config.json", "credential-store"],
    ["dir C:\\Users\\Alice\\.gnupg", "credential-store"],
    ["type C:\\Users\\Alice\\.kube\\config", "credential-store"],
    ["type C:\\Users\\Alice\\.netrc", "credential-store"],
  ];
  for (const [command, rule] of denied) {
    it(`denies: ${command}`, () => {
      const verdict = evaluateBashContainment(command, { homeDir });
      expect(verdict.allowed).toBe(false);
      expect(verdict.rule).toBe(rule);
    });
  }

  it("still folds POSIX escape tricks when the home is a Windows path", () => {
    expect(evaluateBashContainment("cat ~/.fus\\ion/settings.json", { homeDir }).allowed).toBe(false);
  });

  const allowed = [
    "type C:\\Users\\Alice\\project\\README.md",
    "cat .fusion\\tasks\\FN-1\\PROMPT.md",
    "dir C:\\work\\repo",
    "printf 'a\\nb'",
  ];
  for (const command of allowed) {
    it(`allows: ${command}`, () => {
      expect(evaluateBashContainment(command, { homeDir })).toEqual({ allowed: true });
    });
  }
});

describe("evaluateBashContainment — normal work is unaffected", () => {
  const allowed = [
    "git status",
    "git commit -m 'feat: add thing'",
    "pnpm --filter @fusion/core exec vitest run src/__tests__/foo.test.ts",
    "pnpm install && pnpm build",
    "cat src/index.ts",
    "ls -la packages/",
    "curl https://registry.npmjs.org/react",
    "grep -rn approvals packages/dashboard/src",
    "node scripts/check-changesets.mjs",
    "cat .fusion/tasks/FN-1/PROMPT.md",
  ];
  for (const command of allowed) {
    it(`allows: ${command}`, () => {
      expect(evaluateBashContainment(command)).toEqual({ allowed: true });
    });
  }

  it("allows empty commands", () => {
    expect(evaluateBashContainment("")).toEqual({ allowed: true });
  });
});

describe("normalizeBashCommandForContainment", () => {
  it("strips quotes/backslashes, folds home spellings, lowercases", () => {
    expect(normalizeBashCommandForContainment("CAT '$HOME'/.FUS\\ION/x")).toBe("cat ~/.fusion/x");
  });
});

describe("wrapToolsWithBashContainment", () => {
  const makeBashTool = (execute: (...args: unknown[]) => Promise<unknown>) => ({
    name: "bash",
    label: "bash",
    description: "",
    parameters: {},
    execute,
  });

  it("blocks a denied command before the underlying tool runs", async () => {
    let executed = false;
    const [wrapped] = wrapToolsWithBashContainment([
      makeBashTool(async () => {
        executed = true;
        return { ok: true };
      }) as never,
    ]);
    const result = (await (wrapped.execute as (...args: unknown[]) => Promise<unknown>)(
      "call-1",
      { command: "cat ~/.fusion/settings.json" },
      undefined,
    )) as { isError?: boolean; error?: string };
    expect(executed).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain("privilege-escalation containment");
  });

  it("blocks a native Windows backslash path before the underlying tool runs", async () => {
    let executed = false;
    const [wrapped] = wrapToolsWithBashContainment([
      makeBashTool(async () => {
        executed = true;
        return { ok: true };
      }) as never,
    ]);
    const result = (await (wrapped.execute as (...args: unknown[]) => Promise<unknown>)(
      "call-win",
      { command: 'powershell -c "Get-Content C:\\Users\\Someone\\.fusion\\settings.json"' },
      undefined,
    )) as { isError?: boolean };
    expect(executed).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("passes allowed commands through untouched", async () => {
    const [wrapped] = wrapToolsWithBashContainment([
      makeBashTool(async () => ({ ok: true, ran: true })) as never,
    ]);
    const result = (await (wrapped.execute as (...args: unknown[]) => Promise<unknown>)(
      "call-2",
      { command: "git status" },
      undefined,
    )) as { ran?: boolean };
    expect(result.ran).toBe(true);
  });

  it("does not wrap non-bash tools", () => {
    const readTool = { name: "read", label: "read", description: "", parameters: {}, execute: async () => ({}) };
    const [unwrapped] = wrapToolsWithBashContainment([readTool as never]);
    expect(unwrapped).toBe(readTool);
  });
});

describe("buildBashContainmentDenialMessage", () => {
  it("names the rule and tells the agent to ask the operator", () => {
    const message = buildBashContainmentDenialMessage({ allowed: false, rule: "approvals-api", reason: "nope" });
    expect(message).toContain("approvals-api");
    expect(message).toContain("ask the operator");
  });
});
