import mdx from "@mdx-js/rollup"
import type { Root as MdastRoot } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import type { Options as RemarkParseOptions } from "remark-parse"
import remarkFrontmatter from "remark-frontmatter"
import remarkMdxFrontmatter from "remark-mdx-frontmatter"
import remarkRehype from "remark-rehype"
import rehypeStringify from "rehype-stringify"
import { type Plugin, unified } from "unified"
import type { PluginOption } from "vite"

const remarkParsePlugin: Plugin<
  [(Readonly<RemarkParseOptions> | null | undefined)?],
  string,
  MdastRoot
> = function (options) {
  this.parser = document => fromMarkdown(document, options)
}

export const createMarkdownProcessor = () =>
  unified().use(remarkParsePlugin).use(remarkRehype)

export const createHtmlMarkdownProcessor = () =>
  createMarkdownProcessor().use(rehypeStringify)

export const solidMarkdown = (): PluginOption =>
  mdx({
    jsxImportSource: "solid-js/h",
    remarkPlugins: [
      remarkFrontmatter,
      [remarkMdxFrontmatter, { name: "frontmatter" }],
    ],
  })
