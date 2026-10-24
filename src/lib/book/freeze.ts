/** Recursively freezes objects, arrays and Map/Set contents. */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  if (value instanceof Map) {
    for (const [k, v] of value) {
      deepFreeze(k, seen);
      deepFreeze(v, seen);
    }
  } else if (value instanceof Set) {
    for (const v of value) deepFreeze(v, seen);
  } else if (!ArrayBuffer.isView(value)) {
    for (const v of Object.values(value as object)) deepFreeze(v, seen);
  }
  return Object.freeze(value);
}
