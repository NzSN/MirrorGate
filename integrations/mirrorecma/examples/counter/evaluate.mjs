import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MODEL_INTERFACE_DESCRIPTOR_SCHEMA, decodeSemanticDescriptor } from 'mirrorecma';
import { createSandboxCompiledModel, evaluateImplementation } from 'mirrorgate-mirrorecma';
import { runCounterSuite } from './dist/suite.js';
import * as generated from './dist/CounterMirror.generated.js';

/** Application-specific model and suite; all lifecycle work is provided by Gate. */
export function counterPlan(configuration) {
  const lock = JSON.parse(readFileSync(new URL('./Counter.mirror-interface.lock.json', import.meta.url), 'utf8'));
  const {contract, semanticDigest, provenance, provenanceDigest, ...resolved} = lock;
  const model = createSandboxCompiledModel({
    metadata: generated.CounterModelInterface,
    descriptor: decodeSemanticDescriptor({...resolved, schema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA}),
    adapterId: 'counter-mbt/v1', publicManifest: generated.CounterPublicManifest,
    targetProfile: generated.CounterAsyncTargetProfile,
    stateComputerContractVersion: generated.CounterAsyncStateComputerContractVersion,
    bindPublicPort: generated.bindCounterAsyncPublicPort,
  });
  const suiteRevision = createHash('sha256').update(readFileSync(new URL('./dist/suite.js', import.meta.url))).digest('hex');
  return {
    taskRef: configuration.taskRef ?? 'counter', gate: configuration.gate,
    policyId: configuration.policyId, runtime: 'node-v1', submission: configuration.submission,
    ...(configuration.agent === undefined ? {} : {agent: configuration.agent}),
    ...(configuration.limits === undefined ? {} : {limits: configuration.limits}),
    model, suite: {id: 'counter-suite', revision: suiteRevision, modelRevision: configuration.modelRevision,
      context: {mirror: configuration.mirror, modelConfig: configuration.modelConfig, tracePaths: configuration.tracePaths},
      run: runCounterSuite},
    disclosure: configuration.disclosure ?? {},
  };
}
export function evaluateCounter(configuration, options = {}) {
  return evaluateImplementation(counterPlan(configuration), options);
}
