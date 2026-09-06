import {Counter, counterAdapter} from './counter.mjs';
/** Public regression fixture: the implementation is faulty; observation is faithful. */
class FaultyCounter extends Counter {
  increment(stride) { super.increment(stride - 1n); }
}
export function createAdapter() { return counterAdapter(new FaultyCounter()); }
