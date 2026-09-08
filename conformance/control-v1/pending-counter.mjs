class PendingCounter {
  #count = 0n;
  reset() { this.#count = 0n; }
  async increment(_stride, signal) {
    await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
  }
  get count() { return this.#count; }
}

export function createAdapter() {
  const counter = new PendingCounter();
  return {
    actions: {
      Initialize: () => counter.reset(),
      Tick: ({Stride}, context) => counter.increment(Stride, context.signal),
    },
    observe: () => ({Count: counter.count}),
  };
}
