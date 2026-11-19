/**
 * Returns one value per key for the whole process. A dependency reinstall can
 * leave the Vite plugin on one installed copy of solid-static while pages
 * re-import another, and both copies must still read the same render state.
 */
export function processShared<T extends object>(
  name: string,
  create: () => T,
  isShared: (value: unknown) => value is T,
): T {
  const key = Symbol.for(`solid-static.${name}`)
  const existing: unknown = Reflect.get(globalThis, key)

  if (isShared(existing)) {
    return existing
  }

  const created = create()
  Reflect.set(globalThis, key, created)
  return created
}
