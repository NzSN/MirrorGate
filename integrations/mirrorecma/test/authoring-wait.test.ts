import { jest } from "@jest/globals";
import { awaitAuthoringOperation } from "../src/authoring-wait.js";

test.each([undefined, null, new Error("failed")])("author rejection preserves %p", async error => {
  await expect(awaitAuthoringOperation(Promise.reject(error), undefined, 1_000)).rejects.toBe(error);
});
test("early timer firing rearms against monotonic deadline", async () => {
  let now = 0;
  const clock = jest.spyOn(performance, "now").mockImplementation(() => now);
  const callbacks: (() => void)[] = [];
  const timer = jest.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
    callbacks.push(fn); return 1;
  }) as never);
  const clear = jest.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  try {
    const waiting = awaitAuthoringOperation(new Promise(() => {}), undefined, 10);
    const checked = expect(waiting).rejects.toMatchObject({ name: "ReplayDeadlineError" });
    now = 9; callbacks.shift()!();
    expect(callbacks).toHaveLength(1);
    now = 10; callbacks.shift()!();
    await checked;
  } finally { clock.mockRestore(); timer.mockRestore(); clear.mockRestore(); }
});
