# Protocol artifacts

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
