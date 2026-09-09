import { ReplayCancelledError, ReplayDeadlineError, type ReplayDeadlineStage } from "mirrorecma";

/** Bound the legacy author callback; replay itself remains owned by MirrorECMA. */
export function awaitAuthoringOperation<T>(
  operation: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number, stage: ReplayDeadlineStage = "registration",
): Promise<T> {
  operation.catch(() => {});
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: { ok: true; value: T } | { ok: false; error: unknown }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason instanceof ReplayDeadlineError
        ? signal.reason : new ReplayCancelledError(signal.reason));
      else if (performance.now() >= deadline) reject(new ReplayDeadlineError(stage, timeoutMs));
      else if (outcome.ok) resolve(outcome.value);
      else reject(outcome.error);
    };
    const abort = () => finish({ ok: false, error: new ReplayCancelledError(signal?.reason) });
    const checkDeadline = () => {
      if (done) return;
      const remaining = deadline - performance.now();
      if (remaining > 0) timer = setTimeout(checkDeadline, Math.ceil(remaining));
      else finish({ ok: false, error: new ReplayDeadlineError(stage, timeoutMs) });
    };
    timer = setTimeout(checkDeadline, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    operation.then(value => finish({ ok: true, value }), error => finish({ ok: false, error }));
  });
}
