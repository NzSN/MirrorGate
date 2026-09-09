# Protocol artifacts

Worker messages and trusted orchestration control use separate protocols.
[Control v1](control-v1/README.md) covers preparation and workers;
[control v2](control-v2/README.md) adds managed hosting and its policy/audit schemas.
The [hosting contract](../docs/agent-hosting-control-v2.md) defines negotiation and
lifecycle rules; [final validation](../docs/managed-workflow-validation.md) records
shared codec, native client and actual runtime checks.

The normative contract is [port protocol v1](../docs/protocol-v1.md). Schemas
use JSON Schema 2020-12 and reject unknown fields. They describe structural
constraints only: byte limits, Unicode scalars, duplicate JSON keys, semantic
set/map equality, budgets, operation-specific results, and lifecycle rules
require the reference validator and shared conformance tests. JSON Schema
string lengths count characters; the protocol additionally enforces UTF-8 bytes.

`mirrorgate.invalid` schema identifiers are stable logical IDs, not downloads.
The public ModelType vocabulary follows Mirrors; the portable v1 subset rejects
opaque values and non-string map keys. `interfaceDigest` is evaluator-provided
identity, not a hash recomputed from the sanitized manifest.

[source-contract.json](source-contract.json) pins the Mirrors contract and
reference ITF encoder revisions used for this vocabulary. This is a source
compatibility record, not a runtime dependency or a claim that every target in
the upstream design is implemented. Profile changes require corpus changes and
compatibility review.

Run the Python corpus with `python3 -m unittest discover -s tests -p test_protocol.py`.
