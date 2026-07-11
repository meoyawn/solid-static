import type {
  LoadedCollectionEntry,
  LoadedCollections,
} from "./content.ts"

let collections: LoadedCollections = {}

export const setCollections = (loaded: LoadedCollections): void => {
  collections = loaded
}

export const getCollection = (name: string): LoadedCollectionEntry[] => {
  const entries = collections[name]

  if (entries === undefined) {
    throw new TypeError(`Unknown collection ${name}`)
  }

  return entries
}
