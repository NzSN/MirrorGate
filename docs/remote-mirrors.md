# Restricted evaluation with a remote Mirrors server

The transport-factory examples below describe the Node/MirrorECMA integration.
The current Rust evaluator facade starts Mirrors over local stdio; its base
model client separately supports TCP/mTLS. See [language support](client-language-support.md).

MirrorGate can isolate the implementation while the trusted evaluator connects
to a separate Mirrors server. Start with the
[framework application guide](../../Mirrors/Docs/application-integration-guide.md),
[Mirrors server setup](../../Mirrors/Docs/remote-server-guide.md), and
[MirrorECMA remote-client guide](../../MirrorECMA/docs/remote-server.md).

## Place each component deliberately

| Component | Responsibility and placement |
| --- | --- |
| Mirrors server | Model validation, generation and comparison; may run on Windows or Linux |
| Trusted evaluator | Owns the suite, private corpus, model connection, TLS credentials and result disclosure |
| Gate controller | Owns admitted policy, snapshots, build/worker lifecycle and Linux/Bubblewrap isolation |
| Submitted worker | Receives only public implementation-port actions and returns observations |

Use `evaluateSuite(suite, options)` from the Gate integration. Its `mirror` option
accepts the same model transport/factory used by MirrorECMA `runSuite`; select a
fresh `connectTlsMirror` transport in trusted evaluator code. Keep the approved
Gate environment, submission/hosted handoff, adapter and cleanup configuration
in the [suite workflow](../integrations/mirrorecma/WORKFLOW.md). Changing the model
endpoint does not replace those settings or move the worker to the model server.

Prepare the model and checked corpus at explicit server-visible paths following
[MirrorECMA project rules](../../MirrorECMA/docs/project-tools.md). Inline-source
upload by `ModelMirrors validate --async` is a separate operation; it does not
upload a Gate suite or deploy its implementation. Configure model-interface
admission for the evaluator's client certificate as well as mTLS authentication.

Do not mount the model client's credentials, private model or expected traces
into the submitted worker merely to enable remote access. The evaluator opens
the model connection; the worker uses Gate's public port. Required network access
for the SUT remains an explicit admitted Gate policy decision.

## Lifetimes and limits

A Mirrors async job belongs to its submitting model connection. Closing that
connection cancels and evicts its jobs. Gate's worker, source snapshot and hosting
ownership remain governed by Gate's own lifecycle; a model job's terminal result
is not evidence that Gate cleanup completed. Preserve the suite integration's
cleanup and inspect its result/receipt rather than closing transports underneath
an active evaluation.

A remote Windows Mirrors service is supported independently of Gate's backend.
Gate still has no Windows/macOS isolation backend: use the admitted Linux/
Bubblewrap controller for restricted execution. See
[backend limits](sandbox/linux-bubblewrap.md) and [compatibility](compatibility.md).
Mirrors' resource proofs and Linux server RSS regression do not establish
leak-freedom of Gate, submitted code or the complete distributed application.
