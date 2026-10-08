import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyClusterHealth,
  classifyOwnership,
  classifyProbeGating,
  deriveIdentityForUrl,
  describeManualProvisioning,
  isPathInside,
  isEphemeralNativeRoot,
  nativeBinary,
  parseArgs,
  planReplacement,
  platformSupport,
  resolveNativeRootCandidates,
  resolveTarget,
  stagedRootFor,
} from "../pg-test-server.mjs";

const osUser = "node";
const env = {};

test("rejects ephemeral roots and parses supported commands", () => {
  assert.equal(isEphemeralNativeRoot(".worktrees/task/native"), true);
  assert.equal(isEphemeralNativeRoot("/repo/.worktrees/task/native"), true);
  assert.equal(isEphemeralNativeRoot("/opt/fusion/native"), false);
  assert.deepEqual(parseArgs(["up", "--", "--port", "55432", "--replace", "--json"]), { command: "up", port: 55432, replace: true, purge: false, json: true, help: false });
  assert.throws(() => parseArgs(["bogus"]), /unknown argument/);
  assert.match(stagedRootFor({ home: "/home/node/.fusion/pg-test-server", platform: "linux", arch: "arm64" }), /15\.18\.0-beta\.17-linux-arm64$/);
});

test("derives identity exactly as postgres URL and environment fallbacks", () => {
  assert.deepEqual(deriveIdentityForUrl({ url: "postgresql://localhost:5432", env, osUsername: osUser }), { role: osUser, password: "", database: osUser });
  assert.deepEqual(deriveIdentityForUrl({ url: "postgresql://alice:p%40ss@localhost:5432", env, osUsername: osUser }), { role: "alice", password: "p@ss", database: "alice" });
  assert.deepEqual(deriveIdentityForUrl({ url: "postgresql://localhost:5432/fusion_test", env: { PGUSER: "fallback" }, osUsername: osUser }), { role: "fallback", password: "", database: "fusion_test" });
  assert.deepEqual(deriveIdentityForUrl({ url: "postgresql://localhost:5432", env: { PGUSERNAME: "preferred", PGUSER: "other", PGDATABASE: "db", PGPASSWORD: "pw" }, osUsername: osUser }), { role: "preferred", password: "pw", database: "db" });
});

test("closes health gates over identities provisioning guarantees", () => {
  const configured = "postgresql://alice:pw@localhost:55432/db";
  const bare = "postgresql://localhost:55432";
  assert.equal(classifyProbeGating({ probeUrl: configured, env, osUsername: osUser, ownership: "script-owned", roleCfg: "alice", databaseCfg: "db" }), "gating");
  assert.equal(classifyProbeGating({ probeUrl: bare, env, osUsername: osUser, ownership: "script-owned", roleCfg: "alice", databaseCfg: "db" }), "diagnostic");
  const health = classifyClusterHealth([
    { kind: "configured", ok: true, gating: true },
    { kind: "plpgsql", ok: true, gating: true },
    { kind: "bare", ok: false, gating: false, code: "28000", message: 'role "node" does not exist' },
  ]);
  assert.equal(health.status, "healthy");
  assert.equal(health.defects.length, 0);
  assert.equal(health.notes.length, 1);
});

test("classifies all blocking PostgreSQL readiness defects", () => {
  assert.equal(classifyClusterHealth([{ ok: false, code: "58P01", message: 'could not access file "$libdir/plpgsql"' }]).status, "missing-plpgsql");
  assert.equal(classifyClusterHealth([{ ok: false, code: "28000", message: 'role "node" does not exist' }]).status, "missing-login-role");
  assert.equal(classifyClusterHealth([{ ok: false, code: "3D000", message: 'database "node" does not exist' }]).status, "missing-database");
  assert.equal(classifyClusterHealth([{ ok: false, code: "ECONNREFUSED" }]).status, "unreachable");
  const both = classifyClusterHealth([{ ok: false, code: "58P01", message: "$libdir/plpgsql" }, { ok: false, code: "28000" }]);
  assert.equal(both.status, "missing-plpgsql");
  assert.deepEqual(both.defects, ["missing-plpgsql", "missing-login-role"]);
});

test("resolves target safeguards and replacement ownership", () => {
  assert.equal(resolveTarget({ argv: { port: 55432 }, env: {}, osUsername: osUser }).port, 55432);
  assert.equal(resolveTarget({ argv: {}, env: { FUSION_PG_TEST_URL_BASE: "not a url" }, osUsername: osUser }).refusal, "malformed-url");
  assert.equal(resolveTarget({ argv: {}, env: { FUSION_PG_TEST_URL_BASE: "postgresql://example.com:55432" }, osUsername: osUser }).refusal, "non-local-host");
  assert.equal(resolveTarget({ argv: {}, env: { FUSION_PG_TEST_URL_BASE: "postgresql://localhost:55432/path" }, osUsername: osUser }).warnings[0].code, "harness-url-concat");
  assert.equal(classifyOwnership({ dataDir: "/runtime", runtimeDataDir: "/runtime" }), "runtime-app-cluster");
  assert.equal(classifyOwnership({ dataDir: "/foreign", ownerMatches: false, executableIsPostgres: true }), "foreign-other-user");
  assert.equal(classifyOwnership({ dataDir: "/foreign", ownerMatches: true, executableIsPostgres: false }), "not-postgres");
  assert.equal(classifyOwnership({}), "foreign-unprovable");
  assert.equal(planReplacement({ ownership: "foreign-proven", health: { status: "healthy", defects: [] }, replaceRequested: true }), "reuse");
  assert.equal(planReplacement({ ownership: "foreign-proven", health: { status: "missing-login-role", defects: ["missing-login-role"] }, replaceRequested: true }), "refuse-foreign-identity-missing");
  assert.equal(planReplacement({ ownership: "foreign-proven", health: { status: "missing-plpgsql", defects: ["missing-plpgsql"] }, replaceRequested: true }), "stop-then-provision");
  assert.equal(planReplacement({ ownership: "foreign-other-user", health: { status: "missing-plpgsql", defects: ["missing-plpgsql"] }, replaceRequested: true }), "refuse-never-touch");
  assert.equal(planReplacement({ ownership: "not-postgres", health: { status: "missing-plpgsql", defects: ["missing-plpgsql"] }, replaceRequested: true }), "refuse-never-touch");
});

// FNXC:PgTestProvisioning 2026-10-08-08:26: KB-050 win32-x64 provisioning, .exe binary resolution, separator-safe ownership, and manual-provisioning text.
test("maps supported platforms to embedded payload packages", () => {
  assert.deepEqual(platformSupport({ platform: "linux", arch: "x64" }), { provision: true, package: "@embedded-postgres/linux-x64" });
  assert.deepEqual(platformSupport({ platform: "linux", arch: "arm64" }), { provision: true, package: "@embedded-postgres/linux-arm64" });
  assert.deepEqual(platformSupport({ platform: "win32", arch: "x64" }), { provision: true, package: "@embedded-postgres/windows-x64" });
  for (const [platform, arch] of [["win32", "arm64"], ["darwin", "arm64"]]) {
    const support = platformSupport({ platform, arch });
    assert.equal(support.provision, false);
    assert.equal(support.package, undefined);
    assert.ok(support.reason.includes(`${platform}-${arch}`));
  }
});

test("resolves native binaries with the platform executable suffix", () => {
  assert.equal(nativeBinary("pg_ctl", "win32"), "pg_ctl.exe");
  assert.equal(nativeBinary("pg_ctl", "linux"), "pg_ctl");
  const root = mkdtempSync(join(tmpdir(), "pg-test-server-native-"));
  try {
    const exeRoot = join(root, "exe"); mkdirSync(join(exeRoot, "bin"), { recursive: true }); writeFileSync(join(exeRoot, "bin", "postgres.exe"), "");
    const posixRoot = join(root, "posix"); mkdirSync(join(posixRoot, "bin"), { recursive: true }); writeFileSync(join(posixRoot, "bin", "postgres"), "");
    const requireResolve = () => { throw new Error("not resolvable"); };
    const candidates = (platform, nativeRoot) => resolveNativeRootCandidates({ platform, arch: "x64", env: { FUSION_PG_TEST_NATIVE_ROOT: nativeRoot }, requireResolve });
    assert.ok(candidates("win32", exeRoot).includes(exeRoot));
    assert.ok(!candidates("win32", posixRoot).includes(posixRoot));
    assert.ok(candidates("linux", posixRoot).includes(posixRoot));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("proves script ownership with separator-safe containment", () => {
  const home = join(tmpdir(), "pg-test-server-home");
  const dataDir = join(home, "clusters", "c1", "data");
  const sibling = join(`${home}-other`, "clusters", "data");
  assert.equal(isPathInside(dataDir, home), true);
  assert.equal(isPathInside(home, home), false);
  assert.equal(isPathInside(sibling, home), false);
  assert.equal(classifyOwnership({ dataDir, serverHome: home, markerMatches: true }), "script-owned");
  assert.equal(classifyOwnership({ dataDir: sibling, serverHome: home, markerMatches: true }), "foreign-proven");
  // Unproven (undefined) process facts, as on win32, never classify a server as not-postgres or foreign-other-user.
  assert.equal(classifyOwnership({ dataDir: join(tmpdir(), "foreign"), pidAlive: true, ownerMatches: undefined, executableIsPostgres: undefined }), "foreign-proven");
});

test("prints manual provisioning instructions", () => {
  const text = describeManualProvisioning({ port: 55432, reason: "No payload." });
  assert.ok(text.startsWith("No payload."));
  assert.ok(text.includes("docker run -d --name fusion-pg-test -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine"));
  assert.ok(text.includes("export FUSION_PG_TEST_URL_BASE=postgresql://postgres:postgres@localhost:55432"));
  assert.ok(text.includes("pnpm pg:test:status"));
});
