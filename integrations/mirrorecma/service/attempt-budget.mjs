import {constants as C, openSync, closeSync, fstatSync, lstatSync, readSync,
  writeFileSync, fsyncSync} from 'node:fs';
import {isAbsolute, sep} from 'node:path';
import {exact, fail, reference} from './protocol.mjs';

/** Operator-owned, finite per-author/corpus budget. Exclusive marker creation
 * is the cross-process admission primitive; no PID lock or reset on restart.
 * A crash can spend an attempt without running it, but can never refund one. */
export function openAttemptBudget(options, callerId) {
  if (process.platform !== 'linux') fail();
  exact(options, ['directory', 'authorRef', 'corpusDigest', 'maxAttempts']);
  reference(options.authorRef);
  if (options.authorRef !== callerId || typeof options.corpusDigest !== 'string'
      || !/^[0-9a-f]{64}$/.test(options.corpusDigest)
      || !Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1
      || options.maxAttempts > 4096 || typeof options.directory !== 'string'
      || !isAbsolute(options.directory) || options.directory.includes('\0')
      || options.directory.split(sep).some(part => part === '.' || part === '..')) fail();
  const flags = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;
  let fd = -1;
  try {
    fd = openSync(sep, flags);
    for (const part of options.directory.split(sep).filter(Boolean)) {
      const next = openSync(`/proc/self/fd/${fd}/${part}`, flags);
      closeSync(fd); fd = next;
    }
    const identity = fstatSync(fd, {bigint:true});
    if (identity.uid !== BigInt(process.getuid()) || (identity.mode & 0o7777n) !== 0o700n) fail();
    const base = `/proc/self/fd/${fd}`;
    const config = JSON.stringify({schema:'mirrorgate.attempt-budget/v1',
      authorRef:options.authorRef, corpusDigest:options.corpusDigest, maxAttempts:options.maxAttempts});
    const configPath = `${base}/budget.json`;
    function checkedFile(path, expected) {
      const file = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const info = fstatSync(file, {bigint:true});
        if (!info.isFile() || info.uid !== identity.uid || (info.mode & 0o7777n) !== 0o600n
            || info.nlink !== 1n || info.size > 1024n) fail();
        if (expected !== undefined) {
          const bytes = Buffer.alloc(1025), count = readSync(file, bytes, 0, bytes.length, 0);
          if (count > 1024 || bytes.subarray(0, count).toString('utf8') !== expected) fail();
        }
      } finally { closeSync(file); }
    }
    try { checkedFile(configPath, config); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      let file;
      try {
        file = openSync(configPath, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
        writeFileSync(file, config); fsyncSync(file);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      } finally {
        if (file !== undefined) closeSync(file);
      }
      fsyncSync(fd); checkedFile(configPath, config);
    }
    const directory = options.directory, maxAttempts = options.maxAttempts;
    let closed = false, nextIndex = 0;
    return Object.freeze({
      consume() {
        if (closed) fail('SERVICE_UNAVAILABLE');
        const current = lstatSync(directory, {bigint:true});
        if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino
            || current.uid !== identity.uid || (current.mode & 0o7777n) !== 0o700n) fail('SERVICE_UNAVAILABLE');
        checkedFile(configPath, config);
        for (let index = nextIndex; index < maxAttempts; index++) {
          const path = `${base}/attempt-${index}`;
          let file;
          try {
            file = openSync(path, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            checkedFile(path); nextIndex = index + 1; continue;
          }
          try {
            writeFileSync(file, 'spent\n'); fsyncSync(file); fsyncSync(fd);
          } finally { closeSync(file); }
          nextIndex = index + 1; return;
        }
        fail('LIMIT_EXCEEDED');
      },
      close() { if (!closed) { closed = true; closeSync(fd); } },
    });
  } catch (error) {
    if (fd >= 0) closeSync(fd);
    throw error;
  }
}
