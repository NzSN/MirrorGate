// Trusted fault fixture. The source is snapshotted by the real Gate backend;
// only public worker operations trigger the selected failure.
import scenario from './scenario.mjs';

const pending = () => new Promise(() => {});
function inject(operation) {
  const selected = scenario.includes(`-${operation}-`) ||
      (operation === 'invoke' && scenario.startsWith('error-spoof-'));
  if (!selected) return;
  if (scenario.endsWith('-protocol')) {
    process.stdout.write('{"v":1,"id":999,"ok":true,"result":null}\n');
    return pending();
  }
  if (scenario.endsWith('-transport')) process.exit(17);
  if (scenario.endsWith('-timeout') || scenario.endsWith('-cancel')) return pending();
  if (scenario.startsWith('error-spoof-')) {
    const code = scenario.endsWith('-admission') ? 'BACKEND_ADMISSION_FAILED' : 'DEADLINE_EXCEEDED';
    process.stdout.write(JSON.stringify({v: 1, id: 3, ok: false,
      error: {code, message: 'same human text'}}) + '\n');
    return pending();
  }
  if (scenario.endsWith('-application')) throw new Error('same human text');
}

export function createAdapter() {
  let count = 0n;
  return {
    actions: {
      Initialize: async () => { await inject('invoke'); count = 0n; },
      Tick: ({Stride}) => { count += Stride; },
    },
    observe: async () => { await inject('observe'); return {Count: count}; },
    dispose: () => {
      if (scenario === 'error-cleanup') throw new Error('same human text');
    },
  };
}
