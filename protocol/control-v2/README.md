# Control v2: managed hosting

The [normative contract](../../docs/agent-hosting-control-v2.md) specifies the
unchanged v1 bootstrap, selected-v2 administrative envelopes and closed hosting
records. `contract.json` is the shared record/limits inventory; `schema.json`
provides complete closed structural schemas. Semantic and UTF-8 bounds are
validated by `supervisor/mirrorgate/control_protocol_v2.py`.

`policy-schema.json` publishes the closed operator policy-v2 shape, including
the optional `mirrorgate.source-view/v1` record on source-only roots. Its
filesystem ownership, mode, canonical-path, overlap, and selector-byte semantics
are additionally enforced by `control_policy.py` and `source_view.py`.

[Wire vectors](../../conformance/control-v2/vectors.jsonl) exercise the versioned
codec; [lifecycle vectors](../../conformance/control-v2/lifecycle.json) specify
controller/backend acceptance separately. Run:

```bash
python3 conformance/control-v2/run
python3 conformance/control-v2/run --schema
```

The second command requires an installed Draft 2020-12 `jsonschema` validator.
Protocol assets do not assert that a runtime profile or controller is available.
Worker v1, control v1 and Mirrors protocol assets are unchanged.
