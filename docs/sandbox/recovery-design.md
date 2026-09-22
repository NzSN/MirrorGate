# MirrorGate crash-recovery design

Status: the versioned local journal, exclusive state-root lease, filesystem
inspection/reclamation, optional delegated-cgroup recovery, native private
receipt, trusted offline CLI, and bounded formal model are implemented. Process
recovery remains ambiguity-only. The current host has no supplied writable
delegated parent, so the required real-cgroup acceptance tier is unavailable.
The design baseline was MirrorGate commit
`173075d318e4be926570a1378fc0aa36a1294f89`.

## Decision and boundary

Recovery starts as an offline trusted-administrator operation over one explicitly
selected state root. It has separate `inspect` and explicit `reclaim` phases. It
is not a control-v1/control-v2 operation, worker RPC, SDK capability, agent tool,
or automatic startup sweep. A restricted agent can never select the root,
authorize retention changes, inspect private records, or invoke reclamation.

The first recovery implementation terminates and reclaims validated abandoned
work. It never resumes or adopts an old connection, session, run, worker, or
controller authority. A new controller incarnation may create new work after
recovery, but it cannot complete an abandoned run or turn the absence of a
resource into a successful cleanup observation.

The recovery unit is one operator-created state root containing:

- one exclusive owner/recoverer lock;
- a versioned, bounded journal and quarantined-record area;
- Gate-owned resource claims for sessions below that root; and
- append-only recovery-attempt observations.

The state root must be an absolute, non-symlinked directory owned by the serving
UID with mode `0700`. Every open and mutation is descriptor-relative beneath a
pinned root identity. Recovery never accepts a path supplied by an untrusted
client and never searches the host for resources that merely look like Gate
resources.

The implemented controller enables durability only when its trusted `control`
invocation supplies `--state-root`. Existing invocations without that option
retain the legacy in-process cleanup profile and make no cross-restart recovery
claim. The implemented `recovery inspect` is read-only. `recovery reclaim`
acquires the exclusive lease, quarantines malformed records, and acts only on
exact descriptor-validated filesystem-directory claims below the selected root
and cgroup children below an explicitly selected delegated parent. Reclaim can
write the native receipt to one new owner-only file with `--receipt`; it never
overwrites an existing file.

## Identity vocabulary

These identities are distinct and must not be substituted for each other.

| Identity | Required meaning |
| --- | --- |
| state-root identity | configured absolute root plus pinned filesystem object identity and owning UID |
| controller instance | random incarnation created once per process, bound to principal UID and host boot identity |
| connection | one live control transport owner; it is not durable authority after disconnect or crash |
| session | stable Gate session ID and owning controller incarnation |
| run | evaluation attempt ID whose behavioral result has one original controller authority |
| resource claim | random resource ID, kind, session ID, immutable kind-specific identity, and lifecycle sequence |
| host boot | platform boot identity used to scope process observations |
| recovery attempt | new random ID, recoverer incarnation, selected root identity, start/end sequence, and per-resource observations |

A PID is only a recorded observation. PID equality, PID existence, command text,
or executable name never proves ownership. The process proof also needs the
recorded boot identity, the exact session/resource binding, and backend-owned
non-PID identity. A persistent pidfd/start-time tuple can at most support a
tested leader identity; it does not prove durable ownership of a descendant
tree or process group. Without an exact tested leader proof or a delegated
cgroup claim, post-restart process recovery is ambiguous and performs no signal.

The catalog and durable-evidence schemas own their own public identities. This
contract references the draft `catalogSelectionRef`, `componentRef`,
`artifactRef`, `producerResultRef`, and `runRef`; it does not define their
schemas. Gate controller/session/boot identities and handles remain private.

## Durable lifecycle

The journal record state machine is versioned as
`mirrorgate.recovery-journal/v1` unless contract review selects another name.
Every transition increments a monotonic record sequence and preserves prior
observations.

```text
unclaimed
    -> allocation_intent
    -> durable_owned
    -> active
    -> cleanup_intent
    -> reclaimed

cleanup_intent -> cleanup_failed -> cleanup_intent
cleanup_intent -> ambiguous
durable_owned/active retained source -> retained_by_policy
retained_by_policy --explicit policy--> cleanup_intent
```

`reclaimed` is terminal for that resource identity. Repeating recovery records
the already-terminal observation without acting again. `ambiguous` is not an
error-retry state: it requires changed operator facts or policy, recorded as a
new attempt, before validation can run again. `cleanup_failed` is retryable but
the earlier failure remains in evidence. A retained source view is never a
cleanup target unless its own durable policy is explicitly changed to
recoverable.

The same states cover interruption at preparation, snapshot freeze, build,
authorization, worker launch, replay/worker use, and cleanup. The stage is
descriptive evidence; it does not weaken the resource proof.

The write ordering is:

1. Commit `allocation_intent` before creating or exposing a resource.
2. Commit the resulting immutable identity as `durable_owned` before use or
   before returning it to a caller. If this commit cannot complete, roll the
   allocation back before exposure.
3. Commit `cleanup_intent` before signaling, unlinking, killing, or removing.
4. Revalidate the live object immediately before the OS action.
5. Commit `reclaimed`, `cleanup_failed`, or `ambiguous` after the observation.

Each commit writes a complete closed record to a new bounded file in the same
filesystem, syncs the file, atomically renames it, and syncs its parent
directory. The journal records a checksum and sequence. Unsupported versions,
unknown fields, duplicate IDs, nonpositive sequences, truncation, checksum failure,
or a record outside the selected root are quarantined and reported without
touching any referenced resource. An implementation must fault-inject every
write, sync, rename, and directory-sync cut point; the formal model assumes a
durable readable record and does not prove filesystem crash consistency.

The current record sequence increases on every accepted publication, but a
standalone current-record file has no independent history anchor and therefore
cannot prove that an operator restored an older otherwise-valid file. This
implementation makes no rollback-detection claim; signing or an anchored ledger
belongs to a later durability profile.

For sandbox processes, `Popen` first starts only MirrorGate's trusted Python
launcher behind an inherited one-byte barrier. The parent commits the exact
PID/start-time/boot/cgroup observation before releasing that launcher to exec
Bubblewrap and submitted code. A failed identity commit closes the barrier,
kills and waits for the inert launcher, and exposes no process handle. Normal
monitor completion records process cleanup before session filesystem cleanup.
After controller death, these leader observations still do not prove descendant
ownership: every nonterminal process claim becomes ambiguous and blocks its
session and enclosing filesystem claims.

## Ownership and restart rules

Exactly one live controller or recoverer holds the nonblocking exclusive lock
for a state root. A second owner fails closed before inspection, allocation, or
action. The lock and controller incarnation are separate: an OS-released lock
after death does not make old authority reusable.

On controller death, incomplete runs are permanently abandoned under that
incarnation. A recoverer gets a fresh incarnation and recovery-attempt ID. It
may validate and terminate/reclaim a resource for its recorded session, but it
cannot send a normal operation, attach a worker, finish the run, or reuse a
connection/session credential. Completed behavioral results remain historical
facts even if their controller later exits or crashes.

Changing host boot identity invalidates process observations. It neither proves
that a process is gone nor independently authorizes a signal. A replaced path,
inode, process identity, cgroup, principal, or root similarly invalidates a
prior validation. Validation and the OS action must occur under the exclusive
lease with no untrusted path resolution between them.

## Resource validation and action table

| Kind | Required proof immediately before action | Action | Ambiguous examples |
| --- | --- | --- | --- |
| filesystem snapshot/session directory | pinned state-root descriptor; recorded relative components restricted below `resources/`; `O_NOFOLLOW`; serving UID/root ownership; exact device/inode/type and Gate xattr ownership token; no link-policy violation | descriptor-relative quarantine rename and bounded unlink/removal of the pinned object | symlink, changed inode/type/token, foreign UID/root, path escape, missing identity fields |
| process/worker | same host boot; exact session/resource claim; non-PID ownership proof; observed process identity still exact | backend-specific terminate/wait, then separately record disappearance | PID reuse, boot change, PID-only record, foreign cgroup/session, unavailable host |
| cgroup | operator-delegated Gate subtree descriptor; exact recorded cgroup identity and session claim; no traversal or delegation change | kill descendants through the supported cgroup API, wait empty, remove exact child | no delegation, changed subtree/inode, foreign member, path alias, unsupported controller |
| retained source view | filesystem proof plus a durable per-resource policy explicitly changed to recoverable | bounded descriptor-relative removal | default retained policy, missing promotion disposition, changed view |

The cgroup proof follows the Linux kernel's
[v2 delegation and containment rules](https://docs.kernel.org/admin-guide/cgroup-v2.html#delegation):
controllers are enabled top-down, non-root migration cannot cross the delegated
boundary without common-ancestor permission, `cgroup.kill` targets the owned
subtree, and descendants retain membership across `fork`, threads, and
`setsid()`. CPU is bandwidth/throttling evidence; memory and swap are distinct
controller scopes. Mock files establish parser behavior only and are never
enforcement evidence.

Missing resources produce `unconfirmed` unless the backend has a tested,
identity-preserving observation that proves the recorded object was reclaimed.
Absence alone is not proof, especially after a torn record or changed boot.

The local journal checksum detects torn or accidental record corruption; it is
not a signature and does not defend against a malicious serving UID. Durable
filesystem mode therefore requires `user.mirrorgate.identity` xattr support and
an operator-private root. Reclamation checks that random token in addition to
device/inode/type, pins the directory before rename, rechecks the moved inode,
and refuses cross-device or foreign-UID descendants. Removal is bounded to
10,000 entries, 64 levels, and ten seconds per resource attempt.

## Evidence and result vocabulary

Behavior, cleanup, and persistence are independent axes. Recovery never rewrites
an evaluation outcome.

- Behavior is `passed`, `failed`, `inconclusive`, or `not_run`. An abandoned
  incomplete run cannot become `passed`.
- Cleanup is recorded per required scope as `confirmed`, `failed`,
  `unconfirmed`, or `not_applicable`. Recovery adds a new observation; it does
  not replace the original cleanup record.
- Persistence is `complete`, `incomplete`, `failed`, or `not_requested`.
  Successful reclamation cannot repair missing evidence bytes retroactively.

The private recovery detail uses `recovered`, `failed`, `ambiguous`,
`retained_by_policy`, and `unconfirmed`. G5 maps those observations to the E1
cleanup axis and reviewed public artifacts. Every attempt is an E1 observation;
public projection exposes only approved scope/outcome and public artifact hashes.
The concrete E1 contract is owned by `Docs/durable-evidence-design.md` and
`tools/evidence/schema/` in Mirrors. A projected cleanup entry uses scope
`gate-recovery`, requirement `required`, `optional`, or `not-applicable`, status
`confirmed`, `failed`, `unconfirmed`, or `not_applicable`, an optional reviewed
`reasonCode`, and public `artifactIds`. A confirmed required cleanup must cite a
retained cleanup, recovery, or producer-native receipt.
Private journal paths, PIDs, boot IDs, controller/session handles, commands,
environment, credentials, private model data, and arbitrary exception text are
never public evidence.

The native `mirrorgate.recovery-receipt/v1` is a closed object. It binds the
immutable original private run reference and outcome, every resource result,
the exactly matching remaining-resource and ownership lists, and one settings
and counter observation for every cgroup result. Its cleanup status is derived
from those results and rederived during projection; a recomputed digest cannot
make an inconsistent projection valid. `--receipt` requires an absolute new
path below an owner-UID mode-`0700` directory and creates mode `0600` bytes with
exclusive, no-follow semantics.

## Failure taxonomy

| Family | Meaning | Permitted effect |
| --- | --- | --- |
| record invalid | unreadable, torn, unknown version/field, duplicate, checksum or sequence failure | quarantine/report only |
| ownership ambiguous | object or principal identity does not exactly match | report only; no OS action |
| owner busy | another controller/recoverer holds the root | fail before inspection/action |
| retained by policy | valid resource intentionally excluded from recovery | report retention; no action |
| backend unavailable | host, kernel feature, delegated subtree, or required API unavailable | unconfirmed/failed according to observation; no inferred success |
| cleanup failed | validated action returned failure or terminal state could not be observed | retain claim and append failure for retry |
| reclaimed | validated action and required terminal observation completed | append terminal result; later retries do not act |

Error messages are bounded and classified. Raw exception text is diagnostic
input for a private local log, not journal or public-evidence content.

## Safety model and claim limits

[`Recovery.tla`](../../specs/recovery/Recovery.tla) is an Apalache-typed bounded
machine with two controller incarnations, two sessions, one run, one resource,
two external object identities, four resource kinds, and every interruption
stage. It models crash invalidation, original run authority, explicit retained
policy, identity and boot replacement, kind-specific validation, action-time
validated history, and prior/current evidence maps.

The corrected model checks:

- `ExclusiveOwner`: at most one controller/recoverer owns the root;
- `NoActionOutsideValidatedSet`: every acted resource has an action-time
  validated history entry;
- `NoCrossSessionReclamation`: the action session equals the claim session;
- `ReclaimedIsTerminal`: every historically reclaimed identity remains in the
  reclaimed phase;
- `EvidenceMonotonic`: prior cleanup and behavior observations are subsets of
  the current observations;
- `AbandonedRunCannotPass` and `PassRequiresCompletedAuthority`; and
- `RetainedRequiresExplicitPolicy`.

Three model-only switches weaken exclusive acquisition, session matching, and
append-only evidence. The gate requires TLC to find the corresponding
`ExclusiveOwner`, `NoCrossSessionReclamation`, and `EvidenceMonotonic`
counterexamples. These are mutation witnesses, not implementation options.

The model proves only the bounded abstract transition system. It does not prove
atomic rename/fsync behavior, lock implementation, PID/pidfd semantics,
descriptor traversal, cgroup delegation, signal delivery, process disappearance,
or kernel cleanup. Those require the OS/backend tests below.

Eventual cleanup is claimed only when all of these assumptions hold:

1. journal records remain durable and readable;
2. a recoverer eventually acquires the exclusive root lock;
3. the recorded resource identity remains stable through validation/action;
4. the required OS operation eventually returns and can establish its terminal
   observation; and
5. the operator schedules recurring retry for retryable failures.

There is no liveness guarantee for ambiguous ownership, an unavailable host,
intentional retention, permanent kernel/filesystem failure, or missing cgroup
delegation.

## Acceptance mapping and downstream obligations

| Roadmap criterion | G1 disposition | Required implementation evidence |
| --- | --- | --- |
| incomplete run never becomes pass | model invariants and original-incarnation `FinishRun` guard | crash-after-start and crash-after-valid-completion tests |
| no unrelated process/path is touched | validated-set and cross-session invariants; resource proof table | adversarial symlink, inode replacement, PID reuse, boot change, foreign UID/root/cgroup tests with zero reclaimer calls |
| reclamation is idempotent | terminal reclaimed history and set-union evidence | interrupt every cleanup/result-persist boundary, then retry |
| lack of proof stays unconfirmed | evidence contract and ambiguity rules | missing object, unreadable record, unavailable backend, and failed terminal-observation tests |
| single recovery owner | `ExclusiveOwner` plus weakened counterexample | two-process nonblocking-lock test |
| retained views stay retained | explicit-policy invariant | retained/unsubmitted/promoted view policy matrix |
| aggregate limits are real or rejected | explicit non-guarantee in G1 | G4 delegated-cgroup descendant and unsupported-admission tests |

G2 receives the closed record states, identities, commit ordering, and quarantine
rules. G3 receives the resource table, offline inspect/reclaim split, and result
families. G4 receives the exact delegated-subtree boundary and no-delegation
non-guarantee. G5 receives the private recovery vocabulary and independent E1
outcome axes.

The implementation deliberately leaves intentionally retained source
views in their existing operator workspace outside the recovery root. It never
discovers or removes them after restart. Process records are reported ambiguous
and never authorize a post-restart signal. Cgroup records are also ambiguous
without the explicitly supplied delegated parent; with it, exact identity and
terminal kernel observations are required. Cleanup failures stay retryable and
retain the earlier failed observation.

Run the model gate from the repository root:

```bash
bash scripts/check-recovery-model.sh
```

The repository pin remains Apalache 0.61.0 until coordinated toolchain review.
The initial local drafting check also ran with Apalache 0.62.2 and must be
reported as a separate tool observation, not evidence that the 0.61.0 gate ran.
