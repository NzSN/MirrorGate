import { mkdtemp, readFile, readdir, stat, writeFile, symlink, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeReceipt, writeTrustedReceipt } from "../src/receipt-writer.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "gate-receipt-")); });
afterEach(async () => { await rm(directory, {recursive: true, force: true}); });

test("exclusive complete publication retains owner-only permissions and removes its temporary file", async () => {
  const path = join(directory, "receipt.json");
  const result = await writeTrustedReceipt({schema: "test/v1", outcome: "passed", items: [1, null, "complete"]}, {path});
  expect(result.status).toBe("written");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({schema: "test/v1", outcome: "passed", items: [1, null, "complete"]});
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(directory)).toEqual(["receipt.json"]);
});

test("competing writers publish exactly one complete record without overwriting", async () => {
  const path = join(directory, "receipt.json");
  const attempts = await Promise.all(Array.from({length: 12}, (_, writer) => writeTrustedReceipt({writer, body: "x".repeat(8000)}, {path})));
  expect(attempts.filter(attempt => attempt.status === "written")).toHaveLength(1);
  expect(attempts.filter(attempt => attempt.status === "failed")).toHaveLength(11);
  const stored = JSON.parse(await readFile(path, "utf8"));
  expect(stored.body).toHaveLength(8000);
  expect(stored.writer).toBeGreaterThanOrEqual(0);
  expect(await readdir(directory)).toEqual(["receipt.json"]);
});

test("existing destinations and symlinks are never replaced or followed", async () => {
  const existing = join(directory, "existing.json"), symbolic = join(directory, "link.json");
  await writeFile(existing, "original", {mode: 0o600});
  await symlink(existing, symbolic);
  expect((await writeTrustedReceipt({changed: true}, {path: existing})).status).toBe("failed");
  expect((await writeTrustedReceipt({changed: true}, {path: symbolic})).status).toBe("failed");
  expect(await readFile(existing, "utf8")).toBe("original");
  expect((await readdir(directory)).sort()).toEqual(["existing.json", "link.json"]);
});

test("symlink parent, missing parent and directories writable by other users are rejected", async () => {
  await symlink(directory, join(directory, "alias"));
  for (const path of [join(directory, "alias", "receipt.json"), join(directory, "missing", "receipt.json")]) {
    expect((await writeTrustedReceipt({}, {path})).status).toBe("failed");
  }
  await chmod(directory, 0o777);
  expect((await writeTrustedReceipt({}, {path: join(directory, "receipt.json")})).status).toBe("failed");
  await chmod(directory, 0o700);
  expect(await readdir(directory)).toEqual(["alias"]);
});

test("non-writable destination produces an explicit failure without temporary artifacts", async () => {
  if (process.getuid?.() === 0) return;
  await chmod(directory, 0o500);
  const result = await writeTrustedReceipt({}, {path: join(directory, "receipt.json")});
  await chmod(directory, 0o700);
  expect(result.status).toBe("failed");
  expect(await readdir(directory)).toEqual([]);
});

test("cancellation during parent/file acquisition leaves no incomplete published record", async () => {
  const abort = new AbortController();
  const pending = writeTrustedReceipt({body: "x".repeat(10_000)}, {path: join(directory, "receipt.json"), signal: abort.signal});
  // Parent traversal has yielded but publication has not occurred.
  abort.abort("interrupted");
  expect((await pending).status).toBe("failed");
  expect(await readdir(directory)).toEqual([]);
});

test("hostile arbitrary rejections cannot execute getters, toJSON or coercion", async () => {
  const cyclic: Record<string, unknown> = {primitive: undefined, bigint: 5n}; cyclic.self = cyclic;
  const hostile = new Proxy({}, {ownKeys() { throw new Error("hostile proxy"); }});
  const value = {cyclic, hostile, error: new Error("private diagnostic"),
    get getter(): never { throw new Error("must not run"); },
    toJSON(): never { throw new Error("must not run"); },
  };
  const serialized = serializeReceipt(value);
  const decoded = JSON.parse(serialized);
  expect(decoded.cyclic.self).toContain("circular");
  expect(decoded.cyclic.primitive).toBe("[undefined]");
  expect(decoded.cyclic.bigint).toEqual({type: "bigint", value: "5"});
  expect(decoded.hostile).toBe("[uninspectable rejection]");
  expect(decoded.getter).toBe("[accessor]");
  expect(decoded.toJSON).toBe("[function]");
  expect(decoded.error.message).toBe("private diagnostic");
  for (const primitive of [undefined, null, false, 12, "rejected", 2n, Symbol("rejected")]) {
    expect(() => JSON.parse(serializeReceipt(primitive))).not.toThrow();
  }
});

test("oversize encoded evidence fails explicitly and bounded diagnostics truncate hostile depth/width", async () => {
  expect((await writeTrustedReceipt({body: "x".repeat(10_000)}, {path: join(directory, "receipt.json"), maxBytes: 256})).status).toBe("failed");
  let deep: unknown = "end";
  for (let index = 0; index < 200; index++) deep = {child: deep};
  expect(serializeReceipt(deep)).toContain("[truncated]");
  expect(JSON.parse(serializeReceipt(Array(2000).fill(1)))).toHaveLength(1025);
  expect(await readdir(directory)).toEqual([]);
});
