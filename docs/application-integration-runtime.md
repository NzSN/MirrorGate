# Public Node application integration

For deployment across machines, see the [remote model-server integration](remote-mirrors.md).

Gate owns the Node adapter kit, `node-esm/v1` preparation, and the public
environment descriptor. The evaluator owns separately approved behavior prose
and selects trusted policy IDs. These APIs do not receive private descriptors,
models, traces, expected states, or evaluator modules.

## Adapter kit contract

`mirrorgate/adapter-kit` exports `generateAdapterKit(manifest, {directory,
behavior?})` and `checkAdapterKit(manifest, {directory})`. Only a strictly
validated `mirrorgate.port/v1` manifest is accepted. Generation owns `port.json`,
`adapter.d.ts`, `adapter-codec.mjs`, `check-adapter.mjs`, and `adapter-kit.json`. Existing unowned or
modified owned files cause failure before any write. `adapter.mjs` and
`PUBLIC-CONTRACT.md` are seeded only when absent, and never become owned files.
The kit identity binds its generator version, native representation version,
public manifest hash, and generated-file hashes. Stable IDs remain quoted keys.

`checkAdapterStructure` validates an explicitly supplied adapter module and
public sample calls using the existing worker codec. It invokes factory reset,
initializer/action handlers, observations, and explicitly requested disposal.
It does not infer semantic correctness. Running the generated checker imports
submitted code: restricted authors run it through admitted `gate_exec`; a local
developer must explicitly pass `--trusted-local` to run it outside Gate.
Generation and freshness checks never import submitted code.

## Preparation and public environment contract

The control policy v2 catalog admits an alternate build plan with `profile:
node-esm/v1`, `entryPoint`, explicit `sourceFiles`, a pinned `runtimeSha256`, and
an explicit `dependencies` list of approved root/content identities. Existing
custom command plans and control v1 remain unchanged. The profile copies only
selected frozen regular files and admitted frozen dependencies. It performs no
install, lifecycle hook, adapter import, or submission-controlled command.
The admitted runtime must be Node and its fixed artifact entry must match.
Dependency selections and source selections reject traversal and symlinks.
Source, runtime, dependency, and final artifact identities remain distinct.

Control v2 adds the discoverable `hosting.public-environment-v1` capability.
A caller opts into delivery by requiring it during hello. The hosted broker
then returns a `mirrorgate.public-contract/v2` envelope containing the unchanged
public task, approved tool IDs, and `mirrorgate.public-environment/v1` descriptor.
Legacy callers retain the previous broker response; public-task, worker v1,
and control v1 closed records are unchanged. The descriptor contains only
logical paths, entry expectations, tool IDs, and admitted numeric limits.
Backend permissions remain authoritative. Submissions cannot override it.

## Acceptance

Focused tests cover recursive declarations/codecs, malformed manifests,
deterministic generation, preservation and collisions, stale detection, safe
quoted IDs, profile root escape/symlink/hash failures, no hook/import execution,
immutable handoff, descriptor disclosure, and negotiated legacy compatibility.
Run Node and Python focused suites, then `scripts/test.sh`. Real Bubblewrap
tests must separately exercise forbidden access and writes for the new profile;
an unavailable backend is reported as unavailable, never as isolation success.

## Usage and version boundaries

```js
import {generateAdapterKit, checkAdapterKit} from 'mirrorgate/adapter-kit';
await generateAdapterKit(publicManifest, {
  directory: './public', behavior: approvedBehavior,
});
const freshness = await checkAdapterKit(publicManifest, {directory: './public'});
```

The generated `adapter-codec.mjs` is a copy of Gate's public worker codec; the
checker is self-contained and needs no evaluator package. Public sample files
contain arrays of `{action, inputs}` with tagged worker-wire values (for example
`{"Stride":{"#bigint":"7"}}`). Through an approved Node development tool,
run `check-adapter.mjs --trusted-local --samples=public-samples.json`, optionally
with `--dispose`. The flag acknowledges submitted-code execution; it grants no
sandbox permission. No sample or expected result is inferred from a private
model. Typecheck authored JavaScript with `tsc --allowJs --checkJs --noEmit
--target es2022 --module nodenext adapter.mjs`.

An operator adds this build plan to a **control policy v2** catalog:

```json
{
  "id": "application.node",
  "profile": "node-esm/v1",
  "entryPoint": "adapter.mjs",
  "sourceFiles": ["adapter.mjs", "application.mjs"],
  "runtimeSha256": "<SHA256 of the admitted Node executable bytes>",
  "dependencies": []
}
```

`runtimeSha256` identifies the exact frozen Node executable, selected from the
runtime command's approved mount. OS libraries continue to come from the existing
operator-approved Linux runtime mounts; this does not claim an immutable OS image.
The executable is copied and verified before authoring, then mounted read-only
for execution. Dependencies permit zero or one explicitly approved preinstalled
`node_modules` tree, declared as `{rootId, relativePath, sha256}`. Its SHA256 is
Gate's frozen-tree digest, including the file manifest, rather than a hash of a
path string. Its root must admit the principal's `prebuilt` access. All files are
frozen at admission and copied under the artifact's `node_modules`; external
symlinks, missing roots, mismatched hashes, and source-selected `node_modules`
are rejected. No packages are installed. Missing imports fail inside the worker.
Preparation identities are retained in the trusted backend session; existing
control-v1 prepared records retain their exact wire shape.

Require `hosting.public-environment-v1` in the hosting client's hello capability
list. The broker's `contract` member then conforms to
[`public-contract.schema.json`](../protocol/control-v2/public-contract.schema.json).
`mirrorgate/public-environment` exports the capability constant and
`validatePublicContract`. Control clients, including C++, still exchange the
same closed frames; only the separately negotiated authoring response changes.
Changing the broker/host support files invalidates old hosting audit receipts;
operators must re-run their actual-runtime dispatcher audit before hosting can
advertise either hosting capability.

The public recursive-value corpus is copied byte-for-byte from Mirrors
`tools/suite-native-vectors.mjs` and SHA-pinned in
`tests/integration/native-values.test.mjs`. The native representation identity is
`mirrors.node-native/v1`, independently of worker protocol and kit versions.

## Local validation, 2026-09-16

The required aggregate gate passed locally with Node 24.15.0, installed
`RUSTUP_TOOLCHAIN=stable` reporting Rust 1.96.0, and the existing TypeScript
compiler selected by `MIRRORGATE_TSC=/usr/local/bin/tsc`:

```bash
RUSTUP_TOOLCHAIN=stable \
MIRRORGATE_TSC=/usr/local/bin/tsc \
MIRRORGATE_NODE_RUNTIME_ROOT=/usr/local \
MIRRORGATE_NLOHMANN_JSON_INCLUDE_DIR=/tmp/mirrorgate-nlohmann-3.11.3 \
bash scripts/test.sh
```

Results: 252 Python tests, 226 Node tests, 4 integration tests, C++ unit/transport/
hosting and actual control scenarios, Rust unit/lifecycle/shared vectors and
formatting, and both workers' sandbox conformance and six shared lifecycle cases.
There were no skips in the final gate. C++ used upstream v3.11.3's untracked
single header, SHA256
`9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6`.

The new focused profile cases exercised actual Bubblewrap denial of private
imports and writes to `/artifact` and `/usr`, successful `/scratch` writes,
restricted structural adapter execution, and descriptor-driven authoring through
broker tools with source sealing. That author was a deterministic test driver,
not a newly audited external coding agent. Actual agent runtime audits remain
operator-specific and must be refreshed after host support changes. These are
local results; no hosted CI or release claim is implied.
