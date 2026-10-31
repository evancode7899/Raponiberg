const frozen = (what: string) => () => {
  throw new TypeError(`Cannot change a frozen ${what}: the cached Book is shared by every request.`);
};

/**
 * Recursively freezes objects, arrays and Map/Set contents. Object.freeze leaves a Map's
 * set/delete/clear (and a Set's add/delete/clear) working, so those throw too.
 */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  if (value instanceof Map) {
    for (const m of ["set", "delete", "clear"]) Object.defineProperty(value, m, { value: frozen("Map") });
    for (const [k, v] of value) {
      deepFreeze(k, seen);
      deepFreeze(v, seen);
    }
  } else if (value instanceof Set) {
    for (const m of ["add", "delete", "clear"]) Object.defineProperty(value, m, { value: frozen("Set") });
    for (const v of value) deepFreeze(v, seen);
  } else if (!ArrayBuffer.isView(value)) {
    for (const v of Object.values(value as object)) deepFreeze(v, seen);
  }
  return Object.freeze(value);
}
