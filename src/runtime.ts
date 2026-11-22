import type { LoadedCollectionEntry, LoadedCollections } from "./content.ts"
import { processShared } from "./shared-state.ts"

interface CollectionStore {
  collections: LoadedCollections
}

const store = processShared(
  "collections",
  (): CollectionStore => ({ collections: {} }),
  (value): value is CollectionStore =>
    typeof value === "object" && value !== null && "collections" in value,
)

export const setCollections = (loaded: LoadedCollections): void => {
  store.collections = loaded
}

export const getCollection = (name: string): LoadedCollectionEntry[] => {
  const entries = store.collections[name]

  if (entries === undefined) {
    throw new TypeError(`Unknown collection ${name}`)
  }

  return entries
}
