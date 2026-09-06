/** Honest adapter: every observation reads the actual Counter instance. */
export class Counter {
  #count = 0n;
  reset() { this.#count = 0n; }
  increment(stride) { this.#count += stride; }
  get count() { return this.#count; }
}
export function counterAdapter(counter) {
  return {
    actions: {
      Initialize: () => counter.reset(),
      Tick: ({Stride}) => counter.increment(Stride),
    },
    observe: () => ({Count: counter.count}),
  };
}
export function createAdapter() { return counterAdapter(new Counter()); }
