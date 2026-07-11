import { readdir, readFile } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import { load } from "js-yaml"

export interface MarkdownProcessor {
  process(file: { path: string; value: string }): Promise<{
    toString(): string
  }>
}

export interface CollectionDefinition<TData = unknown> {
  directory: string
  id?: ((relativePath: string) => string) | undefined
  pattern: RegExp
  schema?: ((value: unknown, sourceName: string) => TData) | undefined
}

export type CollectionDefinitions = Record<string, CollectionDefinition>

export interface CollectionEntry<TData = unknown> {
  body?: string | undefined
  data: TData
  id: string
  rendered?:
    | {
        html: string
      }
    | undefined
}

export type CollectionEntryFor<TDefinitions, TName extends keyof TDefinitions> =
  TDefinitions[TName] extends CollectionDefinition<infer TData>
    ? CollectionEntry<TData>
    : never

export type RenderedCollectionEntryFor<
  TDefinitions,
  TName extends keyof TDefinitions,
> = CollectionEntryFor<TDefinitions, TName> & {
  body: string
  rendered: {
    html: string
  }
}

export type LoadedCollectionEntry = CollectionEntry

export type LoadedCollections = Record<string, LoadedCollectionEntry[]>

const defaultId = (relativePath: string): string =>
  relativePath
    .slice(0, -extname(relativePath).length)
    .replace(/(?:^|\/)index$/, "")

const matches = (pattern: RegExp, value: string): boolean => {
  pattern.lastIndex = 0
  return pattern.test(value)
}

const parseFrontmatter = (
  source: string,
  sourceName: string,
): { body: string; data: unknown } => {
  const match = source.match(
    /^---\n(?<frontmatter>[\s\S]*?)\n---\n?(?<body>[\s\S]*)$/,
  )
  const frontmatter = match?.groups?.frontmatter
  const body = match?.groups?.body

  if (frontmatter === undefined || body === undefined) {
    throw new TypeError(`${sourceName} requires YAML frontmatter`)
  }

  return { body, data: load(frontmatter) }
}

const parseSource = (
  source: string,
  relativePath: string,
): { body: string; data: unknown; renderable: boolean } => {
  const extension = extname(relativePath)

  if (extension === ".md" || extension === ".mdx") {
    return { ...parseFrontmatter(source, relativePath), renderable: true }
  }

  if (extension === ".yaml" || extension === ".yml") {
    return { body: "", data: load(source), renderable: false }
  }

  if (extension === ".json") {
    return { body: "", data: JSON.parse(source), renderable: false }
  }

  return { body: source, data: source, renderable: false }
}

const loadCollection = async (
  definition: CollectionDefinition,
  markdownProcessor: MarkdownProcessor | undefined,
): Promise<LoadedCollectionEntry[]> => {
  const entries = await readdir(definition.directory, {
    recursive: true,
    withFileTypes: true,
  })
  const files = entries
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .filter(filePath =>
      matches(definition.pattern, relative(definition.directory, filePath)),
    )
    .sort()

  return Promise.all(
    files.map(async filePath => {
      const relativePath = relative(definition.directory, filePath)
      const id = definition.id?.(relativePath) ?? defaultId(relativePath)
      const parsed = parseSource(await readFile(filePath, "utf8"), relativePath)
      const data = definition.schema?.(parsed.data, relativePath) ?? parsed.data

      return {
        ...(parsed.renderable
          ? {
              body: parsed.body,
              ...(markdownProcessor === undefined
                ? {}
                : {
                    rendered: {
                      html: String(
                        await markdownProcessor.process({
                          path: filePath,
                          value: parsed.body,
                        }),
                      ),
                    },
                  }),
            }
          : {}),
        data,
        id,
      }
    }),
  )
}

export const loadCollections = async (
  definitions: CollectionDefinitions,
  markdownProcessor?: MarkdownProcessor,
): Promise<LoadedCollections> => {
  const loaded = await Promise.all(
    Object.entries(definitions).map(
      async ([name, definition]) =>
        [name, await loadCollection(definition, markdownProcessor)] as const,
    ),
  )

  return Object.fromEntries(loaded)
}
