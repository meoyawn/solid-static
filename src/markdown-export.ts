/// <reference path="./turndown.d.ts" />

import TurndownService from "turndown"
import { gfm } from "turndown-plugin-gfm"

export interface StaticSiteMarkdownExportOptions {
  /** Glob-like output file patterns to skip. */
  exclude?: string[]
  /** Serve the generated 404 Markdown as the static 404 asset. */
  force404Markdown?: boolean
  /** HTML element names to try, in order, when extracting page content. */
  selectors?: string[]
  /** Additional HTML element names to remove from the Markdown output. */
  removeElements?: string[]
  /** HTML element names to preserve as raw HTML in the Markdown output. */
  keepElements?: string[]
  /** Post-process generated Markdown and receive the output-relative HTML file name. */
  transform?: (markdown: string, fileName: string) => string | Promise<string>
}

const defaultSelectors = ["main", "article", "body"]
const defaultRemoveElements = [
  "nav",
  "footer",
  "header",
  "script",
  "style",
  "noscript",
  "svg",
]

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const globRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${escapeRegExp(pattern).replaceAll("\\*", ".*").replaceAll("\\?", ".")}$`,
  )

const isExcluded = (fileName: string, patterns: readonly string[]): boolean =>
  patterns.some(pattern => globRegExp(pattern).test(fileName))

const extractMainContent = (html: string, selectors: readonly string[]): string => {
  for (const selector of selectors) {
    const tagName = selector.trim()

    if (!/^[A-Za-z][A-Za-z0-9:-]*$/.test(tagName)) {
      throw new TypeError(`Markdown selector ${selector} must be an HTML element name`)
    }

    const match = html.match(
      new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "i"),
    )

    if (match?.[1] !== undefined) {
      return match[1]
    }
  }

  return html
}

const createConverter = (
  options: StaticSiteMarkdownExportOptions,
): TurndownService => {
  const converter = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    headingStyle: "atx",
    hr: "---",
  })

  converter.use(gfm)
  converter.addRule("linkFlattenContent", {
    filter: node => node.nodeName === "A" && node.getAttribute("href") !== null,
    replacement: (content, node) => {
      const href = node.getAttribute("href") ?? ""
      const title = node.getAttribute("title")
      const flat = content.replace(/\s*\n+\s*/g, " ").trim()

      if (flat === "") {
        return href
      }

      return title === null
        ? `[${flat}](${href})`
        : `[${flat}](${href} "${title}")`
    },
  })
  converter.addRule("fencedCodeBlock", {
    filter: node =>
      node.nodeName === "PRE" && node.querySelector("code") !== null,
    replacement: (_content, node) => {
      const code = node.querySelector("code")
      const language =
        code?.getAttribute("class")
          ?.replace(/^language-/, "")
          .split(" ")[0] ?? ""
      const text = code?.textContent ?? ""

      return `\n\`\`\`${language}\n${text.replace(/\n$/, "")}\n\`\`\`\n`
    },
  })

  for (const element of [
    ...defaultRemoveElements,
    ...(options.removeElements ?? []),
  ]) {
    converter.remove(element)
  }

  for (const element of options.keepElements ?? []) {
    converter.keep(element)
  }

  return converter
}

export const markdownFileNameFor = (htmlFileName: string): string => {
  const normalizedFileName = htmlFileName.replace(/^\/+/, "")

  // Treat an empty HTML basename as the root route instead of emitting the
  // invalid `.md` path that static uploaders reject.
  if (normalizedFileName === ".html" || normalizedFileName === "") {
    return "index.md"
  }

  return normalizedFileName.replace(/\.html$/, ".md")
}

export const createMarkdownSiblings = async (
  routes: ReadonlyArray<{ fileName: string; html: string }>,
  options: StaticSiteMarkdownExportOptions,
): Promise<ReadonlyArray<{ fileName: string; source: string }>> => {
  const selectors = options.selectors ?? defaultSelectors
  const exclude = options.exclude ?? []
  const converter = createConverter(options)
  const markdownRoutes: Array<{ fileName: string; source: string }> = []

  for (const route of routes) {
    if (!route.fileName.endsWith(".html") || isExcluded(route.fileName, exclude)) {
      continue
    }

    let source = converter.turndown(extractMainContent(route.html, selectors))

    if (options.transform !== undefined) {
      source = await options.transform(source, route.fileName)
    }

    const markdownSource = `${source.trim()}\n`
    const markdownFileName = markdownFileNameFor(route.fileName)

    markdownRoutes.push({
      fileName: markdownFileName,
      source: markdownSource,
    })

  }

  return markdownRoutes
}
