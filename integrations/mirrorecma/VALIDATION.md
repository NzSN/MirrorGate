# Integration validation history

Current status, 2026-09-09: destination integration, managed authoring,
MirrorECMA 2 core/live checks, installed workflow/service/MCP consumption and
coordinated gates passed. Actual Codex source from the installed MCP protocol
harness passed twice against the existing mTLS Mirrors server. Real outside-Codex
framework registration/dispatch then passed through submission, MBT and confirmed
cleanup (AH11.2).
[Final validation](../../docs/managed-workflow-validation.md) owns exact final
commands, versions and counts. No package publication is claimed.

The following stage reports retain their original counts and then-current
limitations as history; they do not describe an unfinished current core cutover.

## AH8.2 extraction stage

This stage recorded extraction and the prepared/control-v1 provider before
managed hosting and destination delivery. Base checkouts were MirrorGate
`7dc16e763cc51df12fa5725053331a8e87c0150b` and MirrorECMA
`9fbe187e4e884987b29ef1274658cdabd7fe6ef7`, with implementation changes.

Run from this directory with the approved Node 24.15.0 runtime, compatible
MirrorECMA development dependencies and public peer packages available:

```bash
npm run build
npm test -- --silent
MIRRORECMA_ROOT=/path/to/MirrorECMA \
MIRRORS_ROOT=/path/to/Mirrors \
MIRRORGATE_NODE_RUNTIME_ROOT=/approved/node-v24.15.0-linux-x64 \
node scripts/packed-consumer.mjs --sandbox
```

- Build exited 0. All 37 tests in six suites passed: 25 extracted facade,
  manifest, authoring-output and failure tests; eight prepared-provider tests;
  four bounded-author-callback tests.
- Packed ESM JavaScript and strict TypeScript declaration consumers passed.
  The test-only dependency-injection entry is not a public export; package deep
  imports are denied. Runtime peers came from package archives rather than
  repository-relative imports.
- The compiler-owned Counter lock and async binding are byte-identical to the
  original MirrorECMA fixture. The binding was also compiled against the packed
  public MirrorECMA package.
- Actual Linux/Bubblewrap runs used restricted submission-controlled `build.py`
  and Node adapter initialization, both checking that a synthetic private file
  and environment variable were inaccessible. Prepared source hashes were
  validated. No reference implementation was imported into the trusted harness.

| Path | Implementation/model | Result | Evaluation worker starts | Cleanup |
| --- | --- | --- | --- | --- |
| Prepared provider | Correct Counter | Passed | 1 | Confirmed, no remaining resources |
| Prepared provider | Faulty Counter | Semantic mismatch | 1 | Confirmed, no remaining resources |
| Prepared provider | Wrong model digest | Model negotiation rejected | 0 | Confirmed, no remaining resources |
| Extracted `/legacy` | Correct Counter | Passed | Covered by facade lifecycle | Confirmed |
| Extracted `/legacy` | Faulty Counter | Semantic mismatch | Covered by facade lifecycle | Confirmed |
| Extracted `/legacy` | Wrong model digest | Failed | Zero-launch covered by moved tests | Confirmed |

The real replay used the existing Mirrors executable at revision
`0a2e38c6d82e4f96e5c79f821e7fe7f5c1b555e0` and the existing Counter conformance trace.
This did not regenerate private traces or claim new Apalache trace generation.

Initial outer-sandbox runs could not spawn npm subprocesses (`EPERM`); the final
packed/real-backend run executed outside that enclosing sandbox. During test
setup, fixture root selection was corrected to the approved `submission` root.
The final command exited 0 and printed `PACKED PREPARED/V1 SANDBOX + LEGACY GREEN`.

`git diff --check` passed. Full Gate cross-language/native gates and MirrorECMA
core cutover gates belong to the parent integration pass and were not rerun for
this bounded extraction. The former MirrorECMA Gate-aware source remains until
that cutover is validated; this package does not claim completed core decoupling.


## AH8.6/AH8.7 local workflow and installed consumer

The hosted/source/prebuilt workflow, same-owner hosting-tool callback and aggregate
trusted/public receipts were implemented after the extraction evidence above.
The package imports only public libraries and supports MirrorECMA `^1.0.0 ||
^2.0.0`. The old core remains available in the shared checkout during cutover.

With the pinned Node 24.15.0 environment, these commands exited 0:

```bash
npm run build
npm test -- --silent
node scripts/packed-consumer.mjs
node scripts/installed-workflow.mjs --service
```

At this point the integrated Jest run passed **65 tests in nine suites**: 37
extraction/provider/wait checks, 15 workflow checks, three public-receipt checks,
and ten service-owned checks. Later service additions may increase that total.
Tests cover pre-factory failure, arbitrary primary rejection values, source
commit followed by failure, delayed/cancelled factory completion, independent
owners, ambiguous-owner refusal, explicit cleanup handoff and model pass with
failed/unconfirmed cleanup. A public receipt never serializes the primary error,
private report, host output, control handles or private paths.

The installed consumer gate builds/packs only during fixture installation. It
verifies the shared Counter suite differs from MirrorECMA's source only in two
import specifiers and preserves the exact generated binding and lock bytes. The
normal application then runs solely from installed packages, approved config and
its suite. Both direct API and ordinary CLI use the same Gate workflow.

| Case | Hosted source | Approved source | Prebuilt | CLI | Cleanup |
| --- | --- | --- | --- | --- | --- |
| Correct Counter | Passed | Passed | Passed | Exit 0 | Confirmed |
| Faulty Counter | Mismatch | Mismatch | Mismatch | Exit 1 | Confirmed |

Hosting here uses an explicitly **synthetic test author**, not a model-backed
Codex process. It writes the Counter through the real Gate authoring callback,
submits through the real controller, and verifies post-submit tools are rejected.
The actual Bubblewrap authoring/build/worker environments all deny a synthetic
private file and environment variable. The submitted source hash equals the
prepared source hash. This validates the public workflow and restriction path;
real Codex authentication/runtime/audit acceptance belongs to the parent gate.

Two concurrent starts through the installed standard hosting tool used separate
owner connections. The integration prepared and evaluated their submitted sources
on those exact owners, reported passed/mismatch respectively, and handed back
confirmed cleanup without duplicate session closure.

The service-owned installed driver called the same source suite locally and the
same Gate workflow through the installed HTTP proxy. Correct outcomes and counts
matched (`acceptedTraces=1`, `acceptedSteps=2`); the faulty Counter mismatched in
both modes. Both service workflows confirmed cleanup. Final output included:

```text
STANDARD HOSTING TOOL -> SAME-OWNER WORKFLOW HANDOFF GREEN (TWO CONCURRENT RUNS)
INSTALLED WORKFLOW CONSUMER GREEN (SYNTHETIC AUTHOR, REAL RESTRICTED TOOLS/BUILD/WORKER)
INSTALLED HTTP PROXY + SAME SOURCE SUITE + REAL GATE/MIRRORS EQUIVALENCE GREEN
```
