import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createFsHandlers } from "../acp/fs-capabilities.js";
import type { PermissionGate } from "../acp/types.js";

let cwd: string;
let outside: string;

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(path.join(tmpdir(), "claude-acp-fs-cwd-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "claude-acp-fs-out-")));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  await rm(outside, { recursive: true, force: true }).catch(() => undefined);
});

const allowGate: PermissionGate = {
  permissionPolicy: { rules: { file_write_delete: "allow" } },
};

function handlers() {
  const h = createFsHandlers({
    cwd,
    allowRead: true,
    allowWrite: true,
    gate: allowGate,
    allowUnrestricted: true,
  });
  return { read: h.readTextFile!, write: h.writeTextFile! };
}

describe("Claude ACP fs handlers", () => {
  it("read and write a file outside the session directory", async () => {
    const { read, write } = handlers();
    const target = path.join(outside, "other-repo.txt");
    await write({ sessionId: "s", path: path.relative(cwd, target), content: "outside" } as never);
    expect(await readFile(target, "utf8")).toBe("outside");
    const res = await read({ sessionId: "s", path: target } as never);
    expect(res.content).toBe("outside");
  });

  it("refuse reading or writing a .env or private key, inside or outside the session directory", async () => {
    const { read, write } = handlers();
    for (const secret of [path.join(outside, ".env"), path.join(outside, "id_rsa"), ".env", "tls.key"]) {
      await expect(read({ sessionId: "s", path: secret } as never)).rejects.toMatchObject({
        code: "denied_secret",
      });
      await expect(
        write({ sessionId: "s", path: secret, content: "X=1" } as never),
      ).rejects.toMatchObject({ code: "denied_secret" });
    }
  });
});
