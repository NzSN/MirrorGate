# Managed workflow destination validation

Status: AH1–AH12 implemented, integrated and locally validated on 2026-09-09.
The optional AH12 profile is authenticated loopback HTTP. This is local source
and installed-package evidence, not a package publication or hosted deployment.

## Delivered boundary

MirrorGate owns fresh agent hosting, restricted tools/builds/workers, immutable
source/artifact handoff, and the trusted MBT workflow. Control v2 adds hosted runs
while preserving control v1 and worker protocol v1. Node and C++ expose native
hosting clients; the installed MCP adapter supplies the coordinating-agent path.

The separately packaged `mirrorgate-mirrorecma` integration supplies a deferred
implementation factory to ordinary MirrorECMA MBT, retains the original Gate
owner through cleanup, and produces separate trusted and public receipts.
MirrorECMA's selected 2.0.0 source cutover removes Gate-specific core exports;
old facade consumers migrate to `mirrorgate-mirrorecma/legacy`. The optional
service invokes the same local workflow and approved application suite.

Changes are present in `/home/nzsn/Repos/MirrorGate` and
`/home/nzsn/Repos/MirrorECMA`, with destination hashes checked against the reviewed
implementation. Starting revisions were Gate
`7dc16e763cc51df12fa5725053331a8e87c0150b` and MirrorECMA
`9fbe187e4e884987b29ef1274658cdabd7fe6ef7`; these identify the baselines, not new
commits containing this work. Mirrors source remains unchanged at
`0a2e38c6d82e4f96e5c79f821e7fe7f5c1b555e0`. Existing dirty documentation and unrelated
scratch files were preserved. The validation phase did not create commits, tags,
pushes or package releases. Subsequent repository commit/push is recorded in Git
history; package publication remains separate.

## Final gates

All commands below exited 0 from the destination repositories. The final Gate
aggregate was rerun after the real-coordinator MCP compatibility fix.

| Gate | Result |
| --- | --- |
| Gate `bash scripts/test.sh` | 132 Python tests; 221 Node tests; 3 integration tests; 3 CTests; real owned/attached C++ controller cases; Rust tests/formatting; Node/Rust Bubblewrap conformance and lifecycle checks passed. No Python/Node skips. |
| Gate `python3 conformance/control-v2/run --schema` | Shared codec checks, 40 positive wire shapes and 80 closed-record schema negatives passed; Node/C++ also consume the 115 shared vectors. |
| Integration `npm run build` and `npm test -- --silent` | 142 tests in 10 suites passed, including provider, workflow, receipt, service and schema regressions. |
| Integration `python3 service/check-schema.py` | 18 positive service vectors passed. |
| Integration `node scripts/installed-workflow.mjs --service --mcp` | Installed source/hosted/prebuilt/CLI, concurrent hosting-tool handoff, shipped MCP entrypoint, private receipt, and service/source-suite equivalence passed. |
| Gate `bash conformance/control-v1/run` | All 42 cases passed across owned/attached control, TypeScript/C++ callers, Node/Rust workers, correct/faulty/digest-negative/generation/source/cancellation scenarios. |
| MirrorECMA `pnpm run ci --live` | 424 tests in 21 suites, typechecks, generated-output checks, packed Gate-free core consumer, async Counter, live Counter and queue acceptance passed. |
| Mirrors `lake test` | `ALL LAKE TESTS GREEN`, including live Apalache tiers. |
| Mirrors `bash tools/interop/run.sh` | `INTEROP MATRIX GREEN` over stdio, TCP and mTLS for ECMA, C++, Rust and the Haskell reference client; C++ 215/215 passed. |
| Repository review | Destination diff/hash review and `git diff --check` passed. |

The installed workflow fixture builds/packs only during installation. Its normal
application runs use installed public packages, approved configuration and the
same Counter suite as the MirrorECMA source tests, with only the two documented
import-specifier rewrites. Synthetic authors in deterministic fixtures are
explicitly distinguished from the actual model-backed checks below.

The selected toolchain was Node 24.15.0, pnpm 11.22.0, Rust 1.96.0, Python 3.12,
Lean 4.33.0, and checksum-verified Apalache 0.61.0. The real agent profile used
Codex CLI 0.153.4 and `gpt-5.6-sol`. Required Bubblewrap/socket gates ran with real
backend access outside the enclosing development sandbox.

## Actual runtime and coordinating-agent acceptance

The public audit command ran against the final destination runtime bytes and
passed `mirrorgate.codex-dispatch/v1`. It uses the actual Codex dispatcher with a
synthetic local model to exercise allowed and denied tools/context; it does not
substitute for the following authenticated model-backed runs.

1. An installed Counter MCP application received coordinator protocol calls,
   launched a fresh actual Codex implementer into an empty source workspace,
   accepted explicit submission, prepared that exact source, ran ordinary MBT,
   and confirmed both hosting and evaluation cleanup.
2. A second fresh **actual Codex coordinating process** registered the shipped
   MCP entrypoint and invoked `hosting_start` once plus `hosting_status` thirteen
   times. Gate launched a fresh actual Codex implementer. Its explicit submission
   passed MBT and cleanup was confirmed with no remaining resources. The
   temporary coordinating process's private credential home was removed.
3. The first actual authored source was evaluated twice through the same
   installed workflow/suite against one already-running, authorized mTLS Mirrors
   server. Both evaluations passed with one trace/two transitions and confirmed
   cleanup. Both evaluation connection closures left that server running.

| Actual run | Submitted source SHA-256 | Prepared artifact SHA-256 |
| --- | --- | --- |
| Installed MCP protocol harness | `1d7b8f9792b7c46b4b85ca8d5b19b350c9584d4fba8510a3e99c45a2e353f1e1` | `640fa28b2de5531e753e08ae98f0ae75d8afce175f25cd1c53f293f2bfc932d6` |
| Actual coordinating Codex → installed MCP → actual implementer | `204cc2be9c532e8ea96afeccacf65ddafd96b4fb2c30508f932791a798bc607e` | `43682094c1676822a4577d02511b1c6f80c77828e6a7aaeac6f72837c9916eb1` |

The committed and prepared source hashes matched. The common approved Counter
suite revision was `eb13b73e10f694afbed84b693c39f6b914a03e3ee3609aefed464a4a60bbd65a`;
its model revision was
`405b4ffb80464cdf919d986e142b180e044c41caf8e6aabe978db0e8e7aa0340`.
Private receipts, MCP transcripts and runtime logs stayed in private local test
storage. No authentication material or private model reports were added here.

For an operator-configured reproduction, use the
[hosting profile/audit contract](agent-hosting-control-v2.md), the
[Counter application](../integrations/mirrorecma/examples/counter/README.md), and
its registered command:

```text
node /installed/counter/tool.mjs /private/approved-counter.json --receipt /private/new-receipt.json
```

Only approved task references enter MCP tool arguments. The MCP status reports
hosting/evaluation phase and cleanup; the full MBT verdict stays in the trusted
receipt. The optional service exposes the explicitly projected public result.

## Independent review and observed failures

Independent reviewers reproduced and retested fixes for broker accept/close
registration, signalling an already reaped PID, submission after a hosted
deadline, stale progress after a terminal event, ambiguous session-open cleanup,
cancellation/timeout classification, malformed HTTP response socket leakage,
getter-based public projection changes, and overall proxy wait deadlines.
Submission now checks its effective deadline under the same lock as lease
installation, independently of watchdog scheduling.

The actual coordinating Codex additionally exposed `tools/list` requests with
`_meta: {progressToken: 0}`. The adapter now accepts this inert MCP metadata while
retaining closed semantic arguments; the exact captured request and malformed
metadata have regression coverage. The real framework run passed after the fix.
An earlier actual-run handshake timed out during parallel native compilation;
a trusted startup diagnostic and subsequent complete run passed. No timed-out
attempt was counted as successful authoring or confirmed remote cleanup.

## Subsequent projected-collection application evidence

On 2026-09-10, a separate non-Counter application passed the installed
managed-authoring and no-author paths over a compiler-projected collection
interface: 14 traces and 49 transitions passed with confirmed cleanup. A
fault-injected source passed its public build, produced a model mismatch, and
also completed cleanup. Private model, trace, expected-state, and diagnostic
artifacts remained outside this repository and outside the implementer
context. This is dated local application evidence, not a release claim.

The run exposed additional application glue around build-mount discovery,
native collection types, immutable repairs, post-disconnect cleanup evidence,
receipt persistence, and offline setup. The proposed work and acceptance
boundaries are recorded in [restricted workflow follow-ups](restricted-workflow-followups.md);
none of G1-G7 is claimed implemented by this validation.

## Supported scope

This evidence covers the Linux/Bubblewrap profile and the audited Codex identity,
not every agent framework, model/runtime version, operating system or tool
catalog. Resume/delegation and aggregate cgroup guarantees remain outside this
profile. Runtime/support-byte changes invalidate the audit and require renewal.
The optional service is authenticated loopback HTTP with bounded in-memory
retention; remote TLS deployment, durable restart and publication are not claimed.
Isolation protects oracle access; faithful observation still depends on the
submitted adapter reporting the actual implementation state.
