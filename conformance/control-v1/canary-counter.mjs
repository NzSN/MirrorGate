import {lstatSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

const marker = ['mirrorgate', 'private', 'canary'].join('-');
const markerPattern = new RegExp(`${marker}-[0-9]+-[0-9]+`);

function containsMarker(value) {
  try {
    return markerPattern.test(JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item));
  } catch {
    return true;
  }
}

function fileContainsMarker(path) {
  try {
    return markerPattern.test(readFileSync(path).toString('utf8'));
  } catch {
    return false;
  }
}

function treeContainsMarker(root, budget = {files: 0}) {
  if (budget.files >= 256) return false;
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (treeContainsMarker(path, budget)) return true;
    } else if (stat.isFile()) {
      budget.files += 1;
      if (fileContainsMarker(path)) return true;
    }
  }
  return false;
}

export function createAdapter() {
  let count = 0n;
  let leaked = containsMarker(process.env) ||
    fileContainsMarker('/proc/self/environ') ||
    fileContainsMarker('/proc/self/cmdline') ||
    treeContainsMarker('/artifact');
  const inspect = value => { leaked ||= containsMarker(value); };
  return {
    actions: {
      Initialize(inputs) {
        inspect(inputs);
        count = 0n;
      },
      Tick(inputs) {
        inspect(inputs);
        count += inputs.Stride;
      },
    },
    observe() {
      return {Count: leaked ? count + 1n : count};
    },
  };
}
