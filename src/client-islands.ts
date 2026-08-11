import { createHash } from "node:crypto"
import { isAbsolute, relative } from "node:path"
import {
  build,
  normalizePath,
  type Manifest,
  type Plugin,
  type ResolvedConfig,
  type UserConfig,
} from "vite"
import solid from "vite-plugin-solid"

interface RegisteredIsland {
  entryPath: string
  placeholder: string
}

interface ClientChunkOutput {
  code: string
  facadeModuleId: string | null
  fileName: string
  isEntry: boolean
  name: string
  type: "chunk"
}

interface ClientAssetOutput {
  fileName: string
  source: string | Uint8Array
  type: "asset"
}

export interface ClientIslandOutput {
  fileName: string
  source: string | Uint8Array
}

export interface ClientIslandBundle {
  base: string
  entryFiles: Map<string, string>
  outputs: ClientIslandOutput[]
  styleFilesByEntry: Map<string, string[]>
}

export interface ClientIslands {
  buildBundle: () => Promise<ClientIslandBundle>
  plugin: Plugin
}

const islandQuery = "?island"
const resolvedIslandPrefix = "\0solid-static-island:"
const placeholderPrefix = "__SOLID_STATIC_ISLAND_"
const manifestFileName = ".vite/solid-static-islands-manifest.json"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const requireClientOutputs = (
  value: unknown,
): (ClientAssetOutput | ClientChunkOutput)[] => {
  const results = Array.isArray(value) ? value : [value]
  const outputs: (ClientAssetOutput | ClientChunkOutput)[] = []

  for (const result of results) {
    if (!isRecord(result) || !Array.isArray(result.output)) {
      throw new TypeError("Vite did not return a client island bundle")
    }

    for (const output of result.output) {
      if (!isRecord(output) || typeof output.fileName !== "string") {
        throw new TypeError("Vite emitted an invalid client island asset")
      }

      if (
        output.type === "asset" &&
        (typeof output.source === "string" || output.source instanceof Uint8Array)
      ) {
        outputs.push({
          fileName: output.fileName,
          source: output.source,
          type: "asset",
        })
        continue
      }

      if (
        output.type === "chunk" &&
        typeof output.code === "string" &&
        (typeof output.facadeModuleId === "string" ||
          output.facadeModuleId === null) &&
        typeof output.isEntry === "boolean" &&
        typeof output.name === "string"
      ) {
        outputs.push({
          code: output.code,
          facadeModuleId: output.facadeModuleId,
          fileName: output.fileName,
          isEntry: output.isEntry,
          name: output.name,
          type: "chunk",
        })
        continue
      }

      throw new TypeError("Vite emitted an invalid client island asset")
    }
  }

  return outputs
}

const requireClientManifest = (
  outputs: (ClientAssetOutput | ClientChunkOutput)[],
): Manifest => {
  const output = outputs.find(
    candidate =>
      candidate.type === "asset" && candidate.fileName === manifestFileName,
  )

  if (output?.type !== "asset") {
    throw new TypeError("Vite did not emit a client island manifest")
  }

  const source =
    typeof output.source === "string"
      ? output.source
      : new TextDecoder().decode(output.source)
  const manifest: unknown = JSON.parse(source)

  if (!isRecord(manifest)) {
    throw new TypeError("Vite emitted an invalid client island manifest")
  }

  return manifest as Manifest
}

const manifestStyleFiles = (
  manifest: Manifest,
  entryFileName: string,
): string[] => {
  const entry = Object.values(manifest).find(
    chunk => chunk.isEntry === true && chunk.file === entryFileName,
  )

  if (entry === undefined) {
    throw new TypeError(`Client island manifest has no entry ${entryFileName}`)
  }

  const styleFiles = new Set<string>()
  const visited = new Set<string>()

  function visit(chunk: Manifest[string]): void {
    for (const fileName of chunk.css ?? []) {
      styleFiles.add(fileName)
    }

    for (const key of chunk.imports ?? []) {
      if (visited.has(key)) {
        continue
      }

      const imported = manifest[key]

      if (imported === undefined) {
        throw new TypeError(`Client island manifest has no import ${key}`)
      }

      visited.add(key)
      visit(imported)
    }
  }

  visit(entry)
  return [...styleFiles].sort()
}

const developmentModuleUrl = (
  entryPath: string,
  root: string,
): string => {
  const relativePath = relative(root, entryPath)

  if (!isAbsolute(relativePath) && !relativePath.startsWith("..")) {
    return `/${normalizePath(relativePath)}`
  }

  return `/@fs/${normalizePath(entryPath)}`
}

export const createClientIslands = (clientConfig: UserConfig = {}): ClientIslands => {
  const entries = new Map<string, RegisteredIsland>()
  let configuredBase: string | undefined
  let clientMinify: ResolvedConfig["build"]["minify"] = "oxc"
  let config: ResolvedConfig | undefined

  const plugin: Plugin = {
    name: "solid-static-client-islands",
    enforce: "pre",
    config(userConfig) {
      configuredBase = userConfig.base
      clientMinify = userConfig.build?.minify ?? "oxc"
    },
    configResolved(resolvedConfig) {
      config = resolvedConfig
    },
    async resolveId(source, importer) {
      if (!source.endsWith(islandQuery)) {
        return undefined
      }

      const request = source.slice(0, -islandQuery.length)
      const resolved = await this.resolve(request, importer, { skipSelf: true })

      if (resolved === null || resolved.external) {
        throw new TypeError(`Unable to resolve client island ${request}`)
      }

      const entryPath = resolved.id.replace(/\?.*$/, "")
      const key = createHash("sha256").update(entryPath).digest("hex").slice(0, 12)
      const placeholder = `${placeholderPrefix}${key}__`
      const existing = entries.get(key)

      if (existing !== undefined && existing.entryPath !== entryPath) {
        throw new TypeError(`Client island key collision for ${entryPath}`)
      }

      entries.set(key, { entryPath, placeholder })
      return `${resolvedIslandPrefix}${key}`
    },
    load(id) {
      if (!id.startsWith(resolvedIslandPrefix)) {
        return undefined
      }

      const key = id.slice(resolvedIslandPrefix.length)
      const island = entries.get(key)

      if (island === undefined || config === undefined) {
        throw new TypeError(`Unknown client island ${key}`)
      }

      const url =
        config.command === "serve"
          ? developmentModuleUrl(island.entryPath, config.root)
          : island.placeholder

      return `export default ${JSON.stringify(url)}`
    },
  }

  async function buildBundle(): Promise<ClientIslandBundle> {
    if (config === undefined) {
      throw new TypeError("Client islands require resolved Vite configuration")
    }

    const resolvedConfig = config
    const clientBase = clientConfig.base ?? configuredBase ?? resolvedConfig.base

    if (entries.size === 0) {
      return {
        base: clientBase,
        entryFiles: new Map(),
        outputs: [],
        styleFilesByEntry: new Map(),
      }
    }

    const clientBuild = clientConfig.build ?? {}
    const result: unknown = await build({
      ...clientConfig,
      base: clientBase,
      configFile: false,
      logLevel: clientConfig.logLevel ?? resolvedConfig.logLevel ?? "info",
      mode: clientConfig.mode ?? resolvedConfig.mode,
      publicDir: false,
      root: resolvedConfig.root,
      plugins: [clientConfig.plugins, solid()],
      build: {
        ...clientBuild,
        cssCodeSplit: true,
        emptyOutDir: false,
        manifest: manifestFileName,
        minify: clientBuild.minify ?? clientMinify,
        rolldownOptions: {
          ...clientBuild.rolldownOptions,
          input: Object.fromEntries(
            [...entries].map(([key, island]) => [key, island.entryPath]),
          ),
          output: {
            assetFileNames: "assets/islands/[name]-[hash][extname]",
            chunkFileNames: "assets/islands/chunks/[name]-[hash].js",
            entryFileNames: "assets/islands/[name]-[hash].js",
          },
        },
        sourcemap: clientBuild.sourcemap ?? resolvedConfig.build.sourcemap,
        write: false,
      },
    })
    const builtOutputs = requireClientOutputs(result)
    const manifest = requireClientManifest(builtOutputs)
    const entryFiles = new Map<string, string>()
    const styleFilesByEntry = new Map<string, string[]>()

    for (const output of builtOutputs) {
      if (output.type !== "chunk" || !output.isEntry) {
        continue
      }

      const island = entries.get(output.name)

      if (island === undefined) {
        throw new TypeError(`Vite emitted unknown client island ${output.name}`)
      }

      entryFiles.set(island.placeholder, output.fileName)
      styleFilesByEntry.set(
        island.placeholder,
        manifestStyleFiles(manifest, output.fileName),
      )
    }

    if (entryFiles.size !== entries.size) {
      throw new TypeError("Vite did not emit every client island entry")
    }

    return {
      base: clientBase,
      entryFiles,
      outputs: builtOutputs
        .filter(output => output.fileName !== manifestFileName)
        .map(output => ({
          fileName: output.fileName,
          source: output.type === "chunk" ? output.code : output.source,
        })),
      styleFilesByEntry,
    }
  }

  return { buildBundle, plugin }
}
