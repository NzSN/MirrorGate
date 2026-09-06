# Repository Guidelines

## Scope

Read [README.md](README.md) before adding functionality. MirrorGate owns shared
worker execution infrastructure: protocol, supervisor, language shims, and
conformance tests. Model resolution and generation belong to Mirrors; private
specification and evaluation-policy ownership belong to the trusted evaluator.

This repository currently contains initial documentation only. Establish and
verify build/test commands when implementation begins; do not assume a toolchain
or claim an isolation guarantee from the repository layout.

## Architecture constraints

- Place worker communication at the generated implementation port: declared
  actions and inputs, actual observations, and lifecycle controls.
- Keep raw Mirrors messages, expected model states, private configuration, and
  evaluator credentials on the trusted side. A worker must not receive a raw
  `StateComputer` invocation as a shortcut for the public port.
- Keep supervisor policy and protocol semantics independent of any client
  language. Language shims own native invocation and value conversion.
- Reuse versioned public interface/type contracts from Mirrors. Keep worker
  protocol versions distinct from semantic interface digests and runtime profiles.
- Treat submitted build scripts and adapter code as untrusted execution. The
  trusted launcher selects allowed runtime profiles and permissions.

## Implementation and verification

Before implementing a new protocol or sandbox behavior, write its interface,
ownership, failure rules, and acceptance checks under `docs/`; link the relevant
document from the README. Preserve one owner for shared schemas and lifecycle
rules rather than copying them independently into every runtime.

Conformance tests should exercise identical operations and malformed-message
cases across workers. Isolation tests must attempt the prohibited access and
verify denial in the actual configured backend. Report unavailable platform or
backend checks separately from passing checks.

Keep application observation fidelity separate from sandbox isolation: preventing
oracle access does not prove an adapter reports the real implementation's state.
