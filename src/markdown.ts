import mdx from "@mdx-js/rollup"
import GithubSlugger, { slug as githubSlug } from "github-slugger"
import type { Root as HastRoot } from "hast"
import { toString } from "hast-util-to-string"
import type { Root as MdastRoot } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import type { Options as RemarkParseOptions } from "remark-parse"
import remarkFrontmatter from "remark-frontmatter"
import remarkMdxFrontmatter from "remark-mdx-frontmatter"
import remarkRehype from "remark-rehype"
import rehypeStringify from "rehype-stringify"
import { type Plugin, unified } from "unified"
import { visit } from "unist-util-visit"
import type { PluginOption } from "vite"
import type { MarkdownHeading } from "./content.ts"

declare module "vfile" {
  interface DataMap {
    headings: MarkdownHeading[]
  }
}

const rehypeHeadings: Plugin<[], HastRoot> = function () {
  return function (tree, file) {
    const slugger = new GithubSlugger()
    const reserved = new Set<string>()
    const headings: MarkdownHeading[] = []

    visit(tree, "element", function (node) {
      if (typeof node.properties.id === "string") {
        reserved.add(node.properties.id)
      }
    })

    visit(tree, "element", function (node) {
      if (!/^h[1-6]$/u.test(node.tagName)) return

      const text = toString(node)
      let slug = node.properties.id
      if (typeof slug !== "string" || slug === "") {
        const base = githubSlug(text.trim()) === "" ? "section" : text.trim()
        do {
          slug = slugger.slug(base)
        } while (reserved.has(slug))
        reserved.add(slug)
        node.properties.id = slug
      }
      headings.push({ depth: Number(node.tagName.slice(1)), slug, text })
    })

    file.data.headings = headings
  }
}

const remarkParsePlugin: Plugin<
  [(Readonly<RemarkParseOptions> | null | undefined)?],
  string,
  MdastRoot
> = function (options) {
  this.parser = document => fromMarkdown(document, options)
}

export const createMarkdownProcessor = () =>
  unified().use(remarkParsePlugin).use(remarkRehype).use(rehypeHeadings)

export const createHtmlMarkdownProcessor = () =>
  createMarkdownProcessor().use(rehypeStringify)

export const solidMarkdown = (): PluginOption =>
  mdx({
    jsxImportSource: "solid-jsx",
    rehypePlugins: [rehypeHeadings],
    remarkPlugins: [
      remarkFrontmatter,
      [remarkMdxFrontmatter, { name: "frontmatter" }],
    ],
  })
