import type { Enqueue } from "./ports.ts";

export function createSerialQueue(): Enqueue {
  let tail = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}
