import { AsyncLocalStorage } from "node:async_hooks"
import type { Root } from "hast"
import type { GeneratedImageRequest, ImageMetadata } from "./get-image.ts"
import type { ResponsiveImageProps } from "./image.tsx"
import type { SatoriImageOptions } from "./satori.ts"
import type { RenderedMarkdown } from "./content.ts"
import { processShared } from "./shared-state.ts"

export interface RenderEnvironment {
  image: (request: GeneratedImageRequest) => Promise<ImageMetadata>
  responsiveImage: (props: ResponsiveImageProps) => Promise<Record<string, unknown>>
  satoriImage: (options: SatoriImageOptions) => Promise<ImageMetadata>
  islandUrl: (key: string) => string
  prepareDocument: (tree: Root, fileName: string) => Promise<Root>
  prepareMarkdown: (tree: Root, sourcePath: string) => Promise<Root>
  markdown: (file: { path: string; value: string }) => Promise<RenderedMarkdown>
}

const environments = processShared(
  "render-environments",
  () => new AsyncLocalStorage<RenderEnvironment>(),
  (value): value is AsyncLocalStorage<RenderEnvironment> => value instanceof AsyncLocalStorage,
)

export const withRenderEnvironment = <T>(environment: RenderEnvironment, render: () => T): T =>
  environments.run(environment, render)

export function renderEnvironment(): RenderEnvironment {
  const environment = environments.getStore()
  if (environment === undefined) {
    throw new TypeError("Static-site assets require an active rendering environment")
  }
  return environment
}

export const currentRenderEnvironment = (): RenderEnvironment | undefined => environments.getStore()
