import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, link, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

export interface ReceiptWriteOptions {
  readonly path: string;
  readonly signal?: AbortSignal;
  /** Encoded JSON limit; bounded diagnostics may be truncated before encoding. */
  readonly maxBytes?: number;
}
export type ReceiptPersistence =
  | Readonly<{status: "not_requested"}>
  | Readonly<{status: "written"; path: string; bytes: number}>
  | Readonly<{status: "failed"; code: "receipt_write_failed"; error: unknown}>;

/** Inspect own data properties only: never invoke toJSON, getters, or coercion. */
export function serializeReceipt(value: unknown, maxBytes = 4 * 1024 * 1024): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 16 * 1024 * 1024) {
    throw new TypeError("receipt byte limit must be between 256 and 16777216");
  }
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 16_384 || depth > 48) return "[truncated]";
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") return item.length <= 16_384 ? item : `${item.slice(0, 16_384)}[truncated]`;
    if (typeof item === "number") return Number.isFinite(item) ? item : "[non-finite number]";
    if (typeof item === "bigint") return {type: "bigint", value: visit(item.toString(), depth + 1)};
    if (typeof item !== "object") return `[${typeof item}]`;
    if (seen.has(item)) return "[circular or shared reference]";
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, "length");
        const length = descriptor?.value;
        const result: unknown[] = [];
        for (let index = 0; index < Math.min(length, 1024); index++) {
          const entry = Object.getOwnPropertyDescriptor(item, String(index));
          result.push(entry === undefined ? null : "value" in entry ? visit(entry.value, depth + 1) : "[accessor]");
        }
        if (length > 1024) result.push("[truncated]");
        return result;
      }
      // The output has no prototype, so hostile keys cannot install toJSON or
      // mutate its prototype. Accessor values are deliberately not evaluated.
      const output: Record<string, unknown> = Object.create(null);
      let count = 0;
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== "string") continue;
        if (++count > 1024 || nodes > 16_384) { output["[truncated]"] = true; break; }
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (descriptor === undefined) continue;
        output[key.slice(0, 1024)] = "value" in descriptor ? visit(descriptor.value, depth + 1) : "[accessor]";
      }
      return output;
    } catch { return "[uninspectable rejection]"; }
  };
  const text = `${JSON.stringify(visit(value, 0))}\n`;
  if (Buffer.byteLength(text) > maxBytes) throw new RangeError("receipt exceeds its encoded byte limit");
  return text;
}

/** Open every parent component without following symlinks, retaining its inode. */
async function receiptParent(path: string): Promise<FileHandle> {
  if (process.platform !== "linux") throw new Error("receipt persistence requires the supported Linux POSIX profile");
  let parent = await open(sep, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of dirname(path).split(sep).filter(Boolean)) {
      const next = await open(`/proc/self/fd/${parent.fd}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await parent.close();
      parent = next;
    }
    const info = await parent.stat();
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) {
      throw new Error("receipt parent must be owned by the evaluator and not writable by other users");
    }
    return parent;
  } catch (error) { await parent.close(); throw error; }
}

/**
 * Publish complete trusted evidence with exclusive hard-link creation. A rename
 * cannot implement no-overwrite publication. Both links retain mode 0600.
 * Cancellation before publication removes the temporary record; after the
 * link succeeds the complete receipt is committed and is never removed.
 */
export async function writeTrustedReceipt(value: unknown, options: ReceiptWriteOptions): Promise<ReceiptPersistence> {
  let parent: FileHandle | undefined;
  let temporary: string | undefined;
  let file: FileHandle | undefined;
  let result: ReceiptPersistence;
  try {
    if (typeof options.path !== "string" || !isAbsolute(options.path) || options.path.includes("\0") ||
        options.path.endsWith(sep) || basename(options.path) === "." || basename(options.path) === "..") {
      throw new TypeError("receipt path must name an absolute file path");
    }
    const path = resolve(options.path);
    const content = serializeReceipt(value, options.maxBytes);
    options.signal?.throwIfAborted();
    parent = await receiptParent(path);
    const prefix = `/proc/self/fd/${parent.fd}`;
    temporary = `${prefix}/.receipt-${randomUUID()}.tmp`;
    file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    // chmod makes the contract independent of the process umask.
    await file.chmod(0o600);
    await file.writeFile(content, {encoding: "utf8", signal: options.signal});
    await file.sync();
    await file.close(); file = undefined;
    options.signal?.throwIfAborted();
    await link(temporary, `${prefix}/${basename(path)}`);
    result = Object.freeze({status: "written", path, bytes: Buffer.byteLength(content)});
  } catch (error) {
    result = Object.freeze({status: "failed", code: "receipt_write_failed" as const, error});
  }
  const failedCleanup = (error: unknown) => {
    result = Object.freeze({status: "failed", code: "receipt_write_failed" as const, error});
  };
  try { await file?.close(); } catch (error) { failedCleanup(error); }
  try { if (temporary !== undefined) await unlink(temporary); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failedCleanup(error); }
  try { await parent?.close(); } catch (error) { failedCleanup(error); }
  return result;
}
