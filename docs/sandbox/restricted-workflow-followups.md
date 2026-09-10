# Restricted implementation workflow follow-ups

Status: findings recorded 2026-09-10. Every item under **Proposed work** is
unimplemented unless a later document and executable gate say otherwise.

## Evidence that produced these findings

A non-Counter application exercised the installed control-v2 hosting path with
a fresh Codex implementer, restricted source build, generated async public port,
private model replay, and final Gate cleanup. The accepted source passed 14
traces and 49 transitions. A separate fault injection passed its public build,
failed during model evaluation as a mismatch, and also completed cleanup.

The run preserved the intended boundary: the implementer received only the
approved public contract and Gate tools; private specifications, traces,
expected observations, evaluator configuration, and trusted failure details did
not enter authoring, build, or worker mounts. These counts are dated local
evidence, not a new compatibility or release claim, and no private application
artifact is added to this repository.

The successful result also exposed avoidable application glue:

- the authoring brief had to explain that `/source` is read-only during build
  and `/output` is the only writable artifact destination;
- generated client ports use array-shaped sets and maps, while the Node adapter
  boundary uses native `Set` and `Map` values;
- every repair required a new empty submission, copied public seed source, a
  new immutable task record, and separately reviewed feedback text;
- an interrupted coordinating client could lose the terminal cleanup receipt
  even when Gate had already removed its resources;
- the no-author runner returned both trusted and public results internally but
  application code had to implement private receipt persistence itself; and
- an offline application had to wire its compiler executable and package links
  by hand.

## Ownership

| Concern | Owner | Boundary |
| --- | --- | --- |
| Build mount and authoring environment description | MirrorGate hosting/tool SDK | Public, model-independent metadata only |
| Native Node adapter types and public self-test | MirrorGate Node worker SDK | Derived only from the sanitized public manifest |
| Immutable repair lineage and source seeding | MirrorGate control/hosting | No private evaluator values or arbitrary diagnostic text |
| Terminal cleanup retrieval | MirrorGate supervisor/control | Owner-authorized, bounded retention |
| Receipt persistence and result disclosure | `mirrorgate-mirrorecma` | Trusted receipt stays local; public result remains allowlisted |
| Generic mismatch classification | MirrorECMA report API | Implementation-neutral classification; Gate integration decides disclosure |
| Model-interface sealing and corpus projection | Mirrors compiler | Outside Gate control and worker protocols |

MirrorECMA core does not gain Gate endpoints, agent requests, build plans,
submission handling, or receipt storage. MirrorGate does not interpret a model,
expected state, or trace position to implement these items.

## Proposed work

### G1. Public environment descriptor

Add a versioned, sanitized environment descriptor to `public_contract`. For the
current Linux build profile it states that authoring uses writable `/workspace`,
build reads frozen `/source`, and build artifacts go to writable `/output`.
Expose a fixed `MIRRORGATE_OUTPUT=/output` value to build hooks. The descriptor
must come from the admitted profile rather than application prose and must not
contain host paths.

Acceptance requires a fresh implementer to build a source submission without a
task-specific mount hint. Attempts to write below `/source`, the original
workspace, or a host path must still fail in the real Bubblewrap backend.

### G2. Implementation-side Node adapter kit

Generate an optional development kit from the sanitized public manifest. It
contains an `adapter.d.ts`, a minimal adapter skeleton, and a public codec
self-test using the exact Node worker representation: `bigint`, native `Set`,
native `Map` with string keys, arrays for sequences/tuples, and closed records.
This kit is distinct from the trusted generated MirrorECMA port, whose collection
types are array-shaped after proxy conversion.

The kit must contain no model source/path, wire projection, expected state,
trace coordinate, invariant, or provenance field. Tests must compare it with
`sdk/node/protocol.mjs` and `sdk/node/public-model.mjs` so the two collection
representations cannot drift silently.

### G3. Immutable repair attempts

Add an additive hosting operation that creates a fresh attempt from an accepted
public source hash. Its closed record contains the parent run/source identity,
new empty destination, approved seed paths, and bounded feedback codes. The
coordinator may attach separately reviewed public prose, but Gate never derives
that prose from private exceptions or expected values.

Each attempt receives a new run and a fresh revision-1 source identity. Previous
source remains immutable, preparation is still one-shot, and no operation
reopens a submitted workspace. The terminal receipt records the lineage and
the exact public feedback digest.

### G4. Retrievable terminal cleanup

Retain a bounded owner-scoped terminal summary after client EOF or cancellation.
An authorized status lookup returns outcome, cleanup state, and remaining
resource identifiers without adopting or mutating the closed session. Retention
must have a documented size/time bound and survive only the failure modes the
supervisor can support honestly; it is not described as crash-durable until an
actual restart test passes.

Acceptance covers disconnect during authoring, build, worker startup, replay,
and cleanup. A returned `confirmed` state requires the same resource census as
the live close path.

### G5. Shared trusted-receipt writer

Move the hosting example's exclusive-create, mode-`0600` receipt serialization
into the integration package and expose one runner option for both hosted and
no-author evaluation. Arbitrary rejection values remain trusted, bounded, and
cycle-safe. The public CLI continues to print only `PublicWorkflowResult` and
returns nonzero for mismatch, failure, cancellation, or timeout.

### G6. Bounded mismatch classification

If MirrorECMA exposes stable implementation-neutral mismatch classes, add a
separate Gate disclosure flag that can release only an allowlisted class and,
optionally, a public observation ID. Never release expected/actual values,
action inputs, trace/state indices, private variable names, exception text, or
model locations through this flag.

### G7. Cross-repository projected-collection fixture

Add a public synthetic fixture that starts with bounded integer-key functions,
uses compiler-owned projection and async generation, crosses the Gate
array/native-collection bridge, passes restricted replay, detects an injected
observation fault, and confirms cleanup in both cases. It must use public test
data created for the repository; independent private application evidence is
not copied into fixtures.

## Completion rule

Update compatibility or implementation-status claims only after the owning
repository has code, focused negative tests, and its required aggregate gate.
The cross-repository fixture additionally requires pinned revisions and the
documented Mirrors, MirrorECMA, and MirrorGate integration gates. A design or
successful application run alone does not mark G1-G7 implemented.
