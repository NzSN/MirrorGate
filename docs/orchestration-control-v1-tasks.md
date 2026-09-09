# Orchestration Control v1 — Implementation Tasks

This ledger records completed control-v1 work and its historical assignments.
New managed hosting, external MBT integration, and evaluation-service work is
tracked separately in [AH1–AH12](agent-hosting-tasks.md), assigned to
`specification_implementer`. The old role names and successful v1 gates below
do not constitute current hosting/service implementation assignments or evidence.

Status: Gate-side implementation complete and integrated into the MirrorGate
checkout from `051ac0c`; both local and destination aggregate gates passed.
The controlling design is
[orchestration control v1](https://github.com/NzSN/MirrorGate/blob/main/docs/orchestration-control-v1.md).
All implementation assignments use the `fullstack-developer` role. The
coordinator owns integration, independent review, final gates, and this ledger.

## Scope of this landing

Implement the MirrorGate controller, backend preparation/worker broker, Node
and C++ control/managed-worker SDKs, and shared control/backend acceptance.
Keep the frozen worker-v1 protocol and existing administrative `run` interface.
At this landing, the MirrorECMA/MirrorCPP model-facing facades were assigned
to a subsequent step. That step and the later managed-host migration now pass
[final validation](managed-workflow-validation.md); the older Gate-only results
below remain evidence of their original scope.

## Assignments and ownership

| Task | Assigned agent | Owned paths | Exit evidence |
| --- | --- | --- | --- |
| G1: strict control contract, controller and serving | `fullstack-developer` / control_server | `protocol/control-v1/`, shared control fixtures, `control_protocol.py`, `orchestration.py`, `control_server.py`, `cli.py`, Python controller/codec tests | All operations and owner/phase/error rules; stdio/Unix serving; bounds/correlation; async results/events; disconnect and cancellation cleanup |
| G2: policy, immutable preparation, worker broker | `fullstack-developer` / control_backend | `control_policy.py`, `preparation.py`, `worker_broker.py`, scoped existing `sandbox.py`/`artifacts.py`/`policy.py` changes, backend/lease tests | Real source/prebuilt workflows, controlled authoring, immutable handoff, no launch before authorization/attachment, bounded relay and teardown |
| G3: native Node SDK | `fullstack-developer` / control_node | `sdk/node/` control/managed/declaration files, scoped existing worker client changes, package metadata, Node control tests | Strict codec and owner-bound handles, owned/attached clients, managed worker closure delegates to Gate, packed consumer smoke |
| G4: native C++ SDK | `fullstack-developer` / control_cpp | `sdk/cpp/`, `tests/cpp/`, C++ gate script | Same contract and fixtures; Unix/stdio control and worker port; correct/faulty Counter through the real Gate controller without a Node evaluator |
| G4b: C++ transport review and repair | `fullstack-developer` / control_server, after G1 | C++ `transport.hpp`, `transport.cpp`, focused transport regression tests; coordinated handoff from G4 | Bounded reads/writes/connect, SIGPIPE handling, descriptor ownership, stalled peers, owned/attached close, attachment tail preservation |
| G5: integration, review and required gates | coordinator | Task/evidence docs, top-level gate wiring, scoped integration fixes | Existing required-backend suite plus new shared gates, adversarial negative cases, final destination-tree audit |

Agents are not alone in the checkout. They must preserve each other's edits,
communicate interface changes before consumers depend on them, and avoid
modifying another assignment's files without coordination. They must not push,
publish, weaken the backend, relax frozen protocol rules, or mark external
client-facade acceptance complete.

## Integration contracts to freeze first

G1 owns the exact operation/result/event schema and must make its machine-
readable contract available before G3/G4 freeze their codecs. G1 and G2 agree
on one internal backend interface before implementing the controller against it.
The controller owns session phases and public handles; backend modules own
the actual frozen leases, subprocesses, broker sockets, and cleanup mechanics.

The public envelopes remain those in the design. Resolve underspecified
records once in G1's shared contract, including hello capabilities, accepted
operations, operation status/results, session status, attachment exchange,
worker descriptors, and release cleanup mode. Every SDK consumes that same
choice. Do not introduce alternate field spellings in a language SDK.

G2 owns the operator policy catalog schema and supplies one documented example
and test fixture constructor. It must reject unknown fields, unapproved roots,
runtime/mount expansion, unsafe paths, and looser limits. Public Node shim
mounts contain only the required trusted worker/protocol files and manifest;
they must not expose an evaluator checkout or a live authoring tree.

## Required review cases

- Malformed/oversized/unterminated frames, duplicate keys/IDs, invalid Unicode,
  unsafe numbers, unknown operations, and invalid argument combinations.
- Handshake compatibility and actual capability reporting before preparation.
- Same-UID other connections, forged/stale handles, and wrong/replayed tokens.
- Authoring and submission-controlled build hooks denied private data,
  management sockets, extra host roots, and inherited descriptors.
- Sealing while writers run; source/build edits after snapshot; immutable
  manifest bytes and separate semantic/artifact/manifest identities.
- No execution launch before required-match attestation, fresh authorization,
  backend admission, and valid attachment; include native startup markers.
- Physical hello/create correlation; worker/control channel separation;
  invalid native values; no managed dispatch after a failed handshake.
- Concurrent sessions, bounded output queues, event ordering, operation
  retention, lost replies, cancellation, EOF and partial construction.
- Closing blocks new work. Cancellation acknowledgement is not quiescence.
  One Gate-owned forced-stop path; primary failure retained if cleanup fails.
- Node and C++ native clients drive the same controller and existing Node/Rust
  workers. Record backend evidence separately from protocol-only fixtures.

## Gates and completion record

Use the repository's pinned Node 24.15.0 and Rust 1.96.0 for final gates,
Python 3.12, and an actual working unprivileged Bubblewrap backend. Development
checks on another installed tool version do not replace those gates.

Required: existing `scripts/test.sh`, new control/Python/Node/C++ shared gates,
package/declaration consumer checks, `git diff --check`, and source/destination
status review. An unavailable backend is an unavailable/failed required gate,
not a pass. Record exact commands, exits, revisions, remaining limitations,
and the separate follow-on client-facade acceptance here at completion.

### Local implementation evidence — 2026-09-08

G1, G2, G3, G4 and the G4b transport review are complete. The coordinator
independently reviewed the strict codecs and lifecycle paths, added real public
CLI acceptance and deterministic cleanup races, and wired all gates into
`scripts/test.sh` and CI.

The full gate ran with Node `24.15.0`, Rust `1.96.0`, Python `3.12.3`,
Bubblewrap `0.9.0`, GCC `13.3.0`, CMake `3.28.3`, nlohmann/json `3.11.3`, and
the locked TypeScript `6.0.3` declaration-test compiler. The Node runtime was
mounted from the same pinned distribution used by the host tests.

```text
bash scripts/test.sh
exit 0
Python: 82 tests passed
Node/integration: 187 + 2 tests passed, no skips
C++: CTest 2/2 passed plus five real control scenarios
Shared control corpus: 72 cases interpreted by Python, Node and C++
Rust unit/lifecycle/shared vectors: passed
Existing Node/Rust real Counter and six lifecycle scenarios per runtime: passed
```

The Node gate includes packed-package ESM imports and declaration compilation,
owned stdio and attached Unix control, correct/faulty Node and Rust workers,
concurrent same-UID connection ownership, and cancellation of an uncooperative
callback. The C++ native gate runs correct/faulty Node and Rust workers over
owned stdio and a Node worker over attached Unix, without a Node evaluator.

Independent public CLI acceptance verifies private canaries and inherited host
descriptor denial through authoring, submitted build hooks, and execution;
immutable source/build handoff; wrong attestation before launch; cleanup on
control EOF during a build with a detached descendant; idle session deadlines;
repeated sequential sessions; and retained disposal failure after all physical
resources are removed. Deterministic regressions cover one shared cleanup
owner, late close after automatic cleanup failure, event ordering across
sessions, and a deadline arriving during session allocation. A separate
1,932-case structural mutation probe produced no unexpected Python exceptions.

Implementation log: `/tmp/mirrorgate-control-v1-full-gate.log`. Focused review
logs include `/tmp/mirrorgate-control-acceptance-reviewed.log`,
`/tmp/mirrorgate-control-g1-python78-final.log` (80 tests after additions), and
`/tmp/mirrorgate-control-g4b-ctest-final.log`. These are local evidence, not
hosted CI or published release records.

The experimental MirrorECMA and MirrorCPP model-facing orchestration facades
now pass the local shared matrix recorded in MirrorECMA's
`docs/shared-orchestration-acceptance.md`: both facades, Node/Rust workers,
owned/attached control, trace and generated replay, correct/faulty outcomes,
wrong-digest zero-launch paths, source authoring, and cancellation. This is
local dirty-tree evidence. Hosted CI, publication, and released client-guide
section-13 support remain separate and unclaimed.

### Destination integration and independent verification

The coordinator integrated 61 reviewed source, configuration, and documentation
files into `/home/nzsn/Repos/MirrorGate`. Every destination file was checked
against base `051ac0c17d19f41960d41cd3830a9556e3670e77` before writing and
byte-verified afterward. Generated build directories and installed dependencies
were excluded from the source transfer. No existing destination edits conflicted.

The destination installed its locked test dependency independently, then ran:

```text
npm ci --ignore-scripts
exit 0
bash scripts/test.sh
exit 0
```

The full destination gate passed with the same pinned toolchain: Python 82/82,
Node/integration 189/189 with zero skips, CTest 2/2, five real native C++
controller scenarios, Rust unit/lifecycle/vector tests, and both existing
Node/Rust sandbox Counter and lifecycle gates. Evidence:
`/tmp/mirrorgate-control-v1-destination-gate.log`.

Final documentation path/fence checks, source/destination file parity, and
`git diff --check` passed. Changes were uncommitted at that integration
checkpoint; the implementation is now recorded by the commit containing this
ledger. The later shared model-facade matrix and checked controller-shutdown
receipts are documented in the
[MirrorECMA acceptance ledger](https://github.com/NzSN/MirrorECMA/blob/main/docs/shared-orchestration-acceptance.md).
Package publication and hosted CI results remain separate from local evidence;
the SDK compatibility manifest keeps the control profile experimental.
