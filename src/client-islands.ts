import { createHash } from "node:crypto"
import { isAbsolute, relative } from "node:path"
import {
  build,
  normalizePath,
  type Plugin,
  type ResolvedConfig,
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
  entryUrls: Map<string, string>
  outputs: ClientIslandOutput[]
  styleUrls: string[]
}

export interface ClientIslands {
  buildBundle: () => Promise<ClientIslandBundle>
  plugin: Plugin
}

const islandQuery = "?island"
const resolvedIslandPrefix = "\0solid-static-island:"
const placeholderPrefix = "__SOLID_STATIC_ISLAND_"

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

const publicAssetUrl = (base: string, fileName: string): string => {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`
  return `${normalizedBase}${fileName}`
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

export const createClientIslands = (): ClientIslands => {
  const entries = new Map<string, RegisteredIsland>()
  let config: ResolvedConfig | undefined

  const plugin: Plugin = {
    name: "solid-static-client-islands",
    enforce: "pre",
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

    if (entries.size === 0) {
      return {
        entryUrls: new Map(),
        outputs: [],
        styleUrls: [],
      }
    }

    const result: unknown = await build({
      base: resolvedConfig.base,
      configFile: false,
      logLevel: resolvedConfig.logLevel ?? "info",
      publicDir: false,
      root: resolvedConfig.root,
      plugins: [solid({ ssr: true })],
      build: {
        cssCodeSplit: false,
        emptyOutDir: false,
        minify: resolvedConfig.build.minify,
        rolldownOptions: {
          input: Object.fromEntries(
            [...entries].map(([key, island]) => [key, island.entryPath]),
          ),
          output: {
            assetFileNames: "assets/islands/[name]-[hash][extname]",
            chunkFileNames: "assets/islands/chunks/[name]-[hash].js",
            entryFileNames: "assets/islands/[name]-[hash].js",
          },
        },
        sourcemap: resolvedConfig.build.sourcemap,
        write: false,
      },
    })
    const builtOutputs = requireClientOutputs(result)
    const entryUrls = new Map<string, string>()

    for (const output of builtOutputs) {
      if (output.type !== "chunk" || !output.isEntry) {
        continue
      }

      const island = entries.get(output.name)

      if (island === undefined) {
        throw new TypeError(`Vite emitted unknown client island ${output.name}`)
      }

      entryUrls.set(
        island.placeholder,
        publicAssetUrl(resolvedConfig.base, output.fileName),
      )
    }

    if (entryUrls.size !== entries.size) {
      throw new TypeError("Vite did not emit every client island entry")
    }

    return {
      entryUrls,
      outputs: builtOutputs.map(output => ({
        fileName: output.fileName,
        source: output.type === "chunk" ? output.code : output.source,
      })),
      styleUrls: builtOutputs
        .filter(
          (output): output is ClientAssetOutput =>
            output.type === "asset" && output.fileName.endsWith(".css"),
        )
        .map(output => publicAssetUrl(resolvedConfig.base, output.fileName)),
    }
  }

  return { buildBundle, plugin }
}
