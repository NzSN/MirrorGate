# Filtered source views implementation plan

Status: implemented and locally validated on 2026-09-10. This plan was derived
from [`supervisor-design.md`](supervisor-design.md#filtered-source-views) and now
records the frozen contract, delegated work, independent fixes, and acceptance
evidence.

## Objective

Allow an operator to select a conventional repository root while exposing only
an explicit public subset to restricted source authoring and preparation. The
original repository, omitted paths, and selector remain outside the sandbox.
The materialized subset is the sole writable authoring workspace and the sole
input to source freezing.

The change stays inside MirrorGate's existing ownership:

```text
operator policy + pinned repository
                |
                v
trusted source-view materializer
                |
                v
supervisor-owned writable workspace
                |
                v
authoring -> source freeze -> build -> artifact freeze -> worker
```

Mirrors model semantics, MirrorECMA replay, worker RPC, control requests, and
existing unfiltered roots do not change.

## Frozen version-1 contract

### Policy shape

`mirrorgate.control-policy/v2` roots may add one optional `sourceView` field:

```json
{
  "id": "application-source",
  "path": "/srv/MirrorRBT",
  "kinds": ["source"],
  "allowedUids": [1000],
  "sourceView": {
    "schema": "mirrorgate.source-view/v1",
    "workspaceRoot": "/srv/MirrorRBT/.mirrors/work",
    "includePaths": [
      "package.json",
      "tsconfig.json",
      "app",
      "src",
      "tests",
      ".mirrors/public"
    ]
  }
}
```

`includePaths` contains exact relative files or directories. A directory
includes its complete descendant tree. Version 1 has no glob, negation,
exclude, optional-path, or ignore-file syntax. This makes selection deterministic
and keeps absent-by-default behavior.

The parser:

- accepts `sourceView` only in policy catalog v2;
- requires root `kinds` to equal `["source"]` modulo order;
- requires `workspaceRoot` to be an existing real directory owned by the
  supervisor UID, mode `0700`, with a pinned device/inode identity;
- requires 1 to 1,024 include paths and at most 65,535 aggregate UTF-8 bytes;
- applies the existing canonical relative-path rules and rejects `.`;
- sorts paths by Unicode scalar order;
- rejects duplicates and ancestor/descendant overlaps; and
- computes `selectorSha256` as lowercase SHA-256 over
  `UTF8("mirrorgate.source-view-selector/v1") || 0x00 || canonicalJson`, where
  `canonicalJson` is `{"includePaths":[...]}` with sorted paths, no whitespace,
  UTF-8, and unescaped non-ASCII scalars.

Policy v1 retains its exact root schema and rejects `sourceView`. Existing v2
documents without `sourceView` retain their bytes-to-behavior interpretation.

### Materialization

After session and principal admission, but before an author or submitted command
can start, the backend materializes a configured source view in an exclusively
created `session-<sessionId>` directory beneath the operator-approved
`workspaceRoot`. The resolved submission `relativePath` is the source root for
`includePaths`. The workspace root is deployment state and is not part of the
portable selector digest.

Materialization must:

1. pin and recheck the source root identity;
2. traverse every included component through directory descriptors with
   `O_NOFOLLOW`;
3. accept ordinary directories and single-link regular files only;
4. reject symlinks, hard-linked files, special files, invalid UTF-8 names,
   changing files/directories, missing paths, and destination collisions;
5. enforce the session snapshot count, byte, depth, and path bounds across the
   complete view before publication;
6. pin and recheck the workspace-root identity, create the deterministic session
   destination exclusively, and publish no partial view on failure;
7. reject an include whose selected file/directory tree contains the workspace
   root, preventing materialization from copying its own destination;
8. preserve executable intent while making directories and files writable only
   by the supervisor UID (`0700`, and `0700` or `0600`); and
9. return an immutable initial selected-path manifest and digest.

The initial manifest uses the existing snapshot entry shape and sort order. Its
digest uses the existing snapshot-manifest algorithm so it identifies the exact
bytes initially copied into authoring. Omitted files never enter the staging
directory and therefore cannot be reached through a renamed mount point,
preexisting symlink, or absolute host pathname.

The materializer is a pure trusted preparation step. It does not edit the
repository or copy authoring changes back. For an authoring-enabled session, a
successfully committed or prepared view remains below `workspaceRoot` as an
operator-visible source output after Gate resource cleanup, matching the current
persistence of a live authoring workspace. Failed or unsubmitted authoring views
and every no-author view are removed. Promotion from a retained view remains a
trusted caller operation after acceptance.

### Source identity and receipt

Unfiltered roots keep the existing source snapshot digest exactly.

For a filtered root, the final frozen source lease still has its ordinary
snapshot digest, `sourceSnapshotSha256`. The externally existing `sourceHash`
field becomes:

```text
SHA256(
  UTF8("mirrorgate.filtered-source/v1") || 0x00 ||
  UTF8(canonicalJson({
    sourceViewId,
    selectorSha256,
    selectedManifestSha256,
    sourceSnapshotSha256
  }))
)
```

`sourceViewId` is the selected approved-root ID. This domain separation means
the same final bytes selected by different approved views have different source
identities. Hosted submission and later preparation must return the same
effective `sourceHash`.

The active backend session retains a trusted immutable receipt with schema
`mirrorgate.source-view-receipt/v1` and the five fields above plus `sourceHash`.
There is no post-cleanup receipt registry in version 1. Existing control records
retain only the effective `sourceHash`; the detailed receipt is available to
trusted in-process diagnostics before session cleanup and is not added to closed
control records. The advertised capability
`submission.source-view-v1` states whether any loaded policy provides a source
view. No private host root or omitted path enters capability or control output.

### Lifecycle and cleanup

`BackendSession.input_path` points at the materialized view whenever one exists.
Authoring, submit, no-author source preparation, and build therefore consume the
same tree. The original repository is never mounted.

The session tracks its source-view identity, exact workspace path, persistence
state, and receipt separately from frozen leases. After active authoring and
preparation quiesce, cleanup retains the view only when authoring was enabled and
a source commitment or prepared source exists. That retained tree is intentional
operator-visible output, not a live Gate resource. Cleanup removes failed,
unsubmitted, and no-author views. A removal failure reports `source-view` as a
remaining resource. Opening or materializing a partial session must roll back the
view, leases, and owner registration.

## Compatibility boundaries

- `session.open` keeps `submission.input` as `{rootId, relativePath}`; the request cannot supply
  paths or selectors.
- Control v1/v2 request, response, event, and operation schemas remain byte
  compatible.
- Node and C++ SDK APIs need no new method or record field.
- Worker manifests, worker protocol, runtimes, and generated ports do not change.
- Existing policy-v1 and policy-v2 roots without `sourceView` retain current
  mounting and source-hash behavior.
- A source view is an operator policy choice. A client that requires it may
  require the generic `submission.source-view-v1` capability during hello.

## Failure rules

| Failure | Public family/stage | Required effect |
| --- | --- | --- |
| Invalid source-view policy | Policy file load failure | No control server admission |
| Missing, linked, special, oversized, or changing selected input | `POLICY_DENIED` / `policy` during open | No session handle and no retained view |
| Workspace-root identity, permission, collision, or materializer failure | `POLICY_DENIED` / `policy` during open | No session handle; partial session destination removed |
| Mutation after materialization | Allowed only inside staged `/workspace` | Original repository remains unchanged |
| Final source freeze failure | Existing `PREPARATION_FAILED` / `authoring` or `prepare` | No source commitment or prepared artifact; view removed on cleanup |
| View cleanup failure | Existing `CLEANUP_FAILED` / `cleanup` | `source-view` remains reported |
| Successful authored view | Existing successful cleanup | Retained as intentional operator output, not a remaining Gate resource |

Error strings sent to an agent or public client identify only the selected-path
failure family. They must not disclose the original root, omitted path names,
private file contents, or supervisor-owned staging path.

## Task assignments

### SV1 — Policy and safe materializer

Owner: specification implementer A.

Owned files:

- `supervisor/mirrorgate/control_policy.py`
- new `supervisor/mirrorgate/source_view.py`
- `protocol/control-v2/policy-schema.json`
- new `tests/test_source_view_policy.py`
- new `tests/test_source_view_materializer.py`

Deliver:

- strict v2 policy parsing and deterministic selector identity;
- descriptor-relative bounded materialization and rollback;
- immutable source-view selection/result types; and
- positive and adversarial unit tests covering every parser and filesystem rule.

The public interface exported to SV2 is:

```python
SourceViewPolicy(schema, workspace_root, workspace_identity,
                 include_paths, selector_sha256)
SourceViewMaterialization(path, selected_manifest_sha256, manifest)
materialize_source_view(source, destination, policy,
                        *, max_files, max_bytes) -> SourceViewMaterialization
```

SV1 does not edit backend lifecycle, control codecs, SDKs, or documentation.

### SV2 — Backend lifecycle and effective source identity

Owner: specification implementer B.

Owned files:

- `supervisor/mirrorgate/preparation.py`
- new `tests/test_source_view_backend.py`

Deliver:

- exclusive `workspaceRoot/session-<sessionId>` materialization during
  `open_session` before state publication;
- use of the staged view for authoring, submit, and no-author preparation;
- retention of successfully committed/prepared authored source and removal of
  failed, unsubmitted, or no-author views;
- domain-separated effective source hashes and immutable trusted receipts;
- unchanged hashes for unfiltered roots;
- `submission.source-view-v1` capability reporting; and
- rollback, cleanup, hosted-submit/prepare parity, and concurrency tests.

SV2 consumes SV1's interface exactly and does not change policy parsing,
orchestration/control schemas, SDKs, or documentation.

### SV3 — Real isolation, aggregate behavior, and documentation

Owner: specification implementer C.

Owned files:

- new `tests/test_source_view_isolation.py`
- `docs/sandbox/supervisor-design.md`
- `docs/sandbox/control-policy-v1.md`
- `docs/sandbox/design.md`
- `docs/sandbox/linux-bubblewrap.md`
- `docs/sandbox/README.md`
- `docs/compatibility.md`

Deliver:

- real Bubblewrap tests proving selected files are readable/writable while the
  repository root, `.mirrors/private`, omitted siblings, and host absolute paths
  are unavailable;
- proof that authoring changes affect only the staged view and flow into the
  committed/prepared source;
- proof that successful authored source remains available under the approved
  workspace root while failed and no-author views are cleaned;
- no-view compatibility and cleanup assertions in the real backend; and
- documentation that changes the proposed status only after those tests pass.

SV3 does not edit supervisor implementation, policy parser, generic control
fixtures, SDKs, or unrelated managed-workflow documents.

### SV4 — Independent adversarial review and final gate

Owner: coordinating agent after SV1-SV3 merge.

Review every requirement against destination source. Add fixes within the owning
task's files or return the finding to that owner. At minimum, attempt:

- include overlap, Unicode, boundary counts/bytes, deep trees, and absent input;
- symlink and hard-link entry/components;
- same-size concurrent overwrite and directory-entry race;
- partial-copy failure, workspace-root replacement/collision, and cleanup failure;
- author creation of new files and attempted access to omitted files;
- hosted author submission followed by preparation hash parity;
- no-author preparation parity;
- cancellation or close while authoring/freeze is active; and
- v1/v2 policies without views producing unchanged identities.

Run:

```bash
PYTHONPATH=supervisor python3 -m unittest \
  tests.test_source_view_policy \
  tests.test_source_view_materializer \
  tests.test_source_view_backend -v

PYTHONPATH=supervisor MIRRORGATE_REQUIRE_SANDBOX=1 \
  python3 -m unittest tests.test_source_view_isolation -v

cargo fetch --manifest-path runtimes/rust/Cargo.toml --locked
bash scripts/build.sh
bash scripts/test.sh
```

The final report must distinguish unit, real-backend, and aggregate results;
record skipped/unavailable tiers as failures of their respective acceptance
claims; run `git diff --check`; and verify all moved documentation links.

## Completion evidence

Delegated specification implementers produced the policy/materializer, backend,
and isolation slices. Independent integration review added support for sibling
include paths with shared ancestors, stopped omitted root entries from consuming
view limits, rejected both directions of workspace overlap, pinned destination
writes against rename/symlink replacement and mode changes, closed descriptors
on failed destination creation, reconciled transient cleanup to the final resource
census, verified viewless policy-v2 compatibility, and retained failed rollback
paths for backend-close retry.

The final destination checks passed:

- 80 focused policy, schema, materializer, backend, identity, rollback, and
  compatibility tests;
- 4 real Bubblewrap source-view isolation/lifecycle tests;
- 244/244 Python tests with the required backend and pinned Node runtime;
- 221/221 Node tests plus 3/3 integration tests;
- 3/3 CTest targets and all real C++ controller scenarios;
- 15/15 Rust unit/lifecycle/vector tests with Rust 1.96.0 and rustfmt; and
- Node/Rust cross-language sandbox conformance and all six shared lifecycle cases
  for each runtime.

No control or worker record changed. The aggregate `bash scripts/test.sh` gate
completed successfully with Node 24.15.0 and Rust 1.96.0.

## Completion criteria

The feature is complete only when:

1. a policy-v2 filtered source root opens through the existing control request;
2. the agent and build can access included content but not the original root or
   omitted private content in a real Bubblewrap run;
3. authoring changes occur only in the staged view and are frozen exactly once;
4. successfully committed/prepared authored views remain available beneath the
   approved workspace root, while unsuccessful and no-author views are removed;
5. submission and preparation return one matching effective source hash that
   binds selector, initial manifest, and final snapshot identities;
6. unfiltered v1/v2 behavior and source hashes remain byte-for-byte unchanged;
7. all failure paths publish no partial session and cleanup reports truthfully;
8. focused and aggregate Gate tests pass with the real backend required; and
9. documentation and capability claims match the implemented code.
