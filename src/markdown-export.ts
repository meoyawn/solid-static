import type { Element, Root, RootContent } from "hast"
import { toHtml } from "hast-util-to-html"
import { toMdast } from "hast-util-to-mdast"
import { gfmToMarkdown } from "mdast-util-gfm"
import { toMarkdown } from "mdast-util-to-markdown"

export interface StaticSiteMarkdownExportOptions {
  /** Glob-like output file patterns to skip. */
  exclude?: string[]
  /** Emit the generated 404 Markdown as the static 404 asset. */
  force404Markdown?: boolean
  /** Structured element names to try, in order, when selecting page content. */
  selectors?: string[]
  /** Additional structured element names to omit from Markdown. */
  removeElements?: string[]
  /** Structured element names to serialize as raw HTML in Markdown. */
  keepElements?: string[]
  /** Transform generated Markdown; never receives serialized HTML. */
  transform?: (markdown: string, fileName: string) => string | Promise<string>
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function selectedContent(tree: Root, selectors: string[]): RootContent[] {
  function find(nodes: RootContent[], tagName: string): RootContent[] | undefined {
    for (const node of nodes) {
      if (node.type !== "element") continue
      if (node.tagName === tagName) return node.children
      const selected = find(node.children, tagName)
      if (selected !== undefined) return selected
    }
    return undefined
  }
  for (const selector of selectors) {
    if (!/^[A-Za-z][A-Za-z0-9:-]*$/.test(selector)) throw new TypeError(`Markdown selector ${selector} must be an element name`)
    const selected = find(tree.children, selector.toLowerCase())
    if (selected !== undefined) return selected
  }
  return tree.children
}

function markdownTree(tree: Root, options: StaticSiteMarkdownExportOptions): Root {
  const remove = new Set(["nav", "footer", "header", "script", "style", "noscript", "svg", ...(options.removeElements ?? [])])
  const keep = new Set(options.keepElements ?? [])
  function childrenFor(nodes: RootContent[]): RootContent[] {
    return nodes.flatMap<RootContent>(node => {
      if (node.type !== "element") return [node]
      if (remove.has(node.tagName)) return []
      if (keep.has(node.tagName)) return [{ type: "raw" as const, value: toHtml(node, { allowDangerousHtml: true }) }]
      return [{
        ...node,
        properties: {
          ...node.properties,
          ...(typeof node.data?.originalImageUrl === "string" ? { src: node.data.originalImageUrl } : {}),
        },
        children: childrenFor(node.children) as Element["children"],
      }]
    })
  }
  return { type: "root", children: childrenFor(selectedContent(tree, options.selectors ?? ["main", "article", "body"])) }
}

export const markdownFileNameFor = (htmlFileName: string): string =>
  htmlFileName === ".html" || htmlFileName === ""
    ? "index.md"
    : htmlFileName.replace(/^\/+/, "").replace(/\.html$/, ".md")

export async function createMarkdownSiblings(
  routes: ReadonlyArray<{ fileName: string; tree: Root }>,
  options: StaticSiteMarkdownExportOptions,
): Promise<ReadonlyArray<{ fileName: string; source: string }>> {
  const excluded = (options.exclude ?? []).map(pattern => new RegExp(`^${escapeRegExp(pattern).replaceAll("\\*", ".*").replaceAll("\\?", ".")}$`))
  return Promise.all(routes
    .filter(route => route.fileName.endsWith(".html") && !excluded.some(pattern => pattern.test(route.fileName)))
    .map(async route => {
      const tree = toMdast(markdownTree(route.tree, options), {
        nodeHandlers: {
          raw(_state, node) {
            return { type: "html", value: "value" in node && typeof node.value === "string" ? node.value : "" }
          },
        },
      })
      const markdown = toMarkdown(tree, { bullet: "-", fences: true, extensions: [gfmToMarkdown()] })
      const source = options.transform === undefined ? markdown : await options.transform(markdown, route.fileName)
      return { fileName: markdownFileNameFor(route.fileName), source: `${source.trim()}\n` }
    }))
}
