# Installed Counter consumer

This application supplies the Counter model/binding, approved public task and
reusable suite. `evaluateCounter()` calls Gate's supported local workflow;
there are no caller-written host, credential, broker or cleanup scripts.

Install compatible private/local package archives for `mirrorecma`, `mirrorgate`
and `mirrorgate-mirrorecma`, then install the application development tools and
run `npm run build` once. This compiles only application suite/compiler output,
not MirrorECMA or Gate. Configure the operator-approved roots, build plan and
agent profile in Gate's policy, and adapt `config.example.json` to those IDs.
The public task must include the approved public port declarations and build
contract; the complete generated binding and model stay trusted here.

Normal evaluation is only:

```bash
node run.mjs /approved/counter-config.json
```

For an already available implementation, remove `agent` and select either a
`prebuilt` submission or a source submission with `authoring:false`. Those inputs
use the same generic suite and deferred provider. With a remote Mirrors server,
application code can pass an existing public MirrorECMA transport as `mirror` to
`evaluateCounter`; the evaluation connection closes without stopping that server.

The CLI prints only the bounded public result and exits nonzero for non-pass.
Trusted application code can import `evaluateCounter` to inspect the separate
model, primary-failure, source/artifact and cleanup receipt. Importing the module
does not start hosting or run evaluation.

`suite.ts` is the same suite as MirrorECMA's `examples/mbt-counter/suite.ts`;
only its two import specifiers differ for installed consumption. Its generated
Counter module and lock are unchanged compiler-owned fixture artifacts. Fixture
installation verifies those relationships. Private suite co-location with source
does not grant the author access: Gate mounts only its approved submission root.

The repository's `scripts/installed-workflow.mjs` installs and tests this app
through packed public packages. Its synthetic author is explicitly test-only;
real model-backed Codex authoring requires an admitted operator runtime/profile
and is a separate production-auth acceptance gate. No synthetic host is selected
by this application's normal configuration or by the integration library.

## Register the standard hosting tools over MCP

After the same one-time application build, register this stdio command in the
coordinating agent's MCP configuration:

```bash
node /installed/counter/tool.mjs /approved/counter-config.json
```

The entry point uses Gate's supplied hosting-tool adapter and the same evaluation
handler/suite as the native CLI. It accepts the owned endpoint shown in the sample
config or an attached endpoint with the current UID as `expectedOwner`; each start
retains its dedicated owner connection. Public tool requests select the fixed
`taskRef`, and never supply launcher, credential, model or receipt paths.

MCP status intentionally reports hosting/evaluation phase and cleanup. It does
not serialize the trusted callback outcome or private mismatch diagnostics. For
operator acceptance, an optional private receipt can be written after evaluation:

```bash
node /installed/counter/tool.mjs /approved/counter-config.json \
  --receipt /private/new-counter-receipt.json
```

The absolute receipt path is a process-launch argument, not a tool parameter. The
file is created exclusively with mode `0600`; it must not already exist. It holds
the trusted and public outcomes as diagnostic JSON, with repeated/cyclic error
references represented by a marker. Keep it outside authoring mounts. Standard
input/output remain reserved for MCP; EOF invokes the supplied adapter's cleanup.
