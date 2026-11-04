import { readFile } from "node:fs/promises"
import { extname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Definition, Image, ImageReference, Nodes } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import { CORE_SCHEMA, load, timestampTag } from "js-yaml"
import sharp from "sharp"
import type { Plugin } from "vite"

export interface MarkdownImage {
  end: number
  filePath: string
  props: {
    alt: string
    height: number
    layout: "constrained"
    title?: string
    width: number
  }
  start: number
}

export const imageComponentPath = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "./image.tsx" : "./image.jsx", import.meta.url),
)

export async function findMarkdownImages(
  source: string,
  sourcePath: string,
): Promise<MarkdownImage[]> {
  const tree = fromMarkdown(source)
  const definitions = new Map<string, Definition>()
  const candidates: (Image | ImageReference)[] = []

  function visit(node: Nodes): void {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node)
    } else if (node.type === "image" || node.type === "imageReference") {
      candidates.push(node)
    }
    if ("children" in node) {
      node.children.forEach(visit)
    }
  }

  visit(tree)
  const images = await Promise.all(candidates.map(async node => {
    const definition = node.type === "image" ? node : definitions.get(node.identifier)
    if (definition === undefined || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(definition.url)) {
      return undefined
    }

    const filePath = fileURLToPath(new URL(definition.url, pathToFileURL(resolve(sourcePath))))
    const { width, height } = await sharp(filePath).metadata()
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (width === undefined || height === undefined || start === undefined || end === undefined) {
      throw new TypeError(`Unable to determine Markdown image dimensions or position in ${sourcePath}`)
    }

    return {
      end,
      filePath,
      props: {
        alt: node.alt ?? "",
        height,
        layout: "constrained" as const,
        ...(definition.title === undefined || definition.title === null ? {} : { title: definition.title }),
        width,
      },
      start,
    }
  }))

  return images.filter((image): image is MarkdownImage => image !== undefined)
}

export const replaceMarkdownImages = (
  source: string,
  images: MarkdownImage[],
  replacement: (image: MarkdownImage, index: number) => string,
): string => images.reduceRight(
  (output, image, index) => output.slice(0, image.start) + replacement(image, index) + output.slice(image.end),
  source,
)

const markdownModulePrefix = "\0solid-static-markdown:"

export const markdownImages = (
  serialize: (value: unknown) => string,
): Plugin => ({
  enforce: "pre",
  name: "solid-static-markdown-images",
  async resolveId(source, importer) {
    if (source.includes("?") || extname(source) !== ".md") {
      return undefined
    }
    const resolved = await this.resolve(source, importer, { skipSelf: true })
    return resolved === null || resolved.external
      ? undefined
      : `${markdownModulePrefix}${encodeURIComponent(resolved.id)}.js`
  },
  async load(id) {
    if (!id.startsWith(markdownModulePrefix)) {
      return undefined
    }
    const sourcePath = decodeURIComponent(id.slice(markdownModulePrefix.length, -3))
    this.addWatchFile(sourcePath)
    const source = await readFile(sourcePath, "utf8")
    const match = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---\r?\n?(?<body>[\s\S]*)$/.exec(source)
    if (match?.groups?.frontmatter === undefined || match.groups.body === undefined) {
      throw new TypeError(`${sourcePath} requires YAML frontmatter`)
    }
    const frontmatter: unknown = load(match.groups.frontmatter, {
      schema: CORE_SCHEMA.withTags(timestampTag),
    })
    const body = match.groups.body
    return `
import { renderEnvironment } from ${JSON.stringify(fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./render-environment.ts" : "./render-environment.js", import.meta.url)))}
const content = await renderEnvironment().markdown(${serialize({ path: sourcePath, value: body })})
export const frontmatter = ${serialize(frontmatter)}
export const headings = content.headings
export default () => content.tree
`
  },
  async transform(source, id) {
    const sourcePath = id.split("?")[0] ?? id
    if (!/^\.mdx?$/.test(extname(sourcePath))) {
      return undefined
    }

    const markdownSource = source.replace(
      /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
      frontmatter => frontmatter.replace(/[^\r\n]/g, " "),
    )
    const images = await findMarkdownImages(markdownSource, sourcePath)
    if (images.length === 0) {
      return undefined
    }

    for (const image of images) {
      this.addWatchFile(image.filePath)
    }
    const imports = images.map((image, index) =>
      `import __solidStaticImage${index} from ${JSON.stringify(`${image.filePath}?no-inline`)}`,
    )
    const rewritten = replaceMarkdownImages(source, images, (image, index) =>
      `<__SolidStaticMarkdownImage src={__solidStaticImage${index}} ${Object.entries(image.props).map(([key, value]) => `${key}={${JSON.stringify(value)}}`).join(" ")} />`,
    )

    return `${rewritten}\n\nimport { ResponsiveImage as __SolidStaticMarkdownImage } from ${JSON.stringify(imageComponentPath)}\n${imports.join("\n")}\n`
  },
})
