/** Prepare isolated installed dependencies for the unchanged 42-row control matrix. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const integration = fileURLToPath(new URL('..', import.meta.url));
const gate = resolve(integration, '../..');
const ecma = resolve(process.env.MIRRORECMA_ROOT ?? join(gate, '../MirrorECMA'));
const consumer = process.argv[2];
assert(consumer, 'Pass an empty consumer output directory');
const run = (command, args, cwd = consumer) => {
  const result = spawnSync(command, args, {cwd, encoding:'utf8', env:process.env});
  if(result.error) throw result.error;
  assert.equal(result.status,0,`${command} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};
mkdirSync(consumer,{recursive:true});
// Build/pack belongs to acceptance setup; each scenario runs installed code only.
run(join(ecma,'node_modules/.bin/tsc'),['-p',join(ecma,'tsconfig.json')]);
const archives = {};
for(const [name,source] of [['mirrorecma',ecma],['mirrorgate',gate]]) {
  const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',consumer,'--cache',join(consumer,'npm-cache')],source))[0];
  const target=join(consumer,'node_modules',name);mkdirSync(target,{recursive:true});
  archives[name]=join(consumer,packed.filename);
  run('tar',['-xzf',archives[name],'--strip-components=1','-C',target]);
}
writeFileSync(join(consumer,'package.json'),'{"private":true,"type":"module"}\n');
// Compile the optional integration against the two installed public packages.
// No sibling node_modules, private imports, or integration dev install is needed.
const integrationSource=join(consumer,'integration-source');
mkdirSync(integrationSource,{recursive:true});
cpSync(join(integration,'src'),join(integrationSource,'src'),{recursive:true});
for(const file of ['package.json','tsconfig.json','README.md','VALIDATION.md'])
  if(existsSync(join(integration,file))) copyFileSync(join(integration,file),join(integrationSource,file));
run(join(ecma,'node_modules/.bin/tsc'),['-p',join(integrationSource,'tsconfig.json'),'--typeRoots',join(ecma,'node_modules/@types')]);
const packedIntegration=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',consumer,'--cache',join(consumer,'npm-cache')],integrationSource))[0];
archives['mirrorgate-mirrorecma']=join(consumer,packedIntegration.filename);
const integrationTarget=join(consumer,'node_modules/mirrorgate-mirrorecma');
mkdirSync(integrationTarget,{recursive:true});
run('tar',['-xzf',archives['mirrorgate-mirrorecma'],'--strip-components=1','-C',integrationTarget]);

for(const file of ['tsconfig.matrix.json','test/legacy-matrix-driver.ts','test/fixtures/model-interface/counter/generated-async/CounterMirror.generated.ts']) {
  const target=join(consumer,file);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(integration,file),target);
}
run(join(ecma,'node_modules/.bin/tsc'),['-p',join(consumer,'tsconfig.matrix.json'),'--typeRoots',join(ecma,'node_modules/@types')]);
const metadata={driver:join(consumer,'compiled/test/legacy-matrix-driver.js'),archives};
writeFileSync(join(consumer,'matrix-consumer.json'),JSON.stringify(metadata,null,2)+'\n');
console.log(JSON.stringify(metadata));
