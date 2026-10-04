import mdx from "@mdx-js/rollup"
import type { Program } from "estree"
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
import { type Plugin, type PluggableList, unified } from "unified"
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

const recmaHeadings: Plugin<[], Program> = function () {
  return function (tree, file) {
    tree.body.push({
      type: "ExportNamedDeclaration",
      specifiers: [],
      source: null,
      attributes: [],
      declaration: {
        type: "VariableDeclaration",
        kind: "const",
        declarations: [
          {
            type: "VariableDeclarator",
            id: { type: "Identifier", name: "headings" },
            init: {
              type: "ArrayExpression",
              elements: (file.data.headings ?? []).map(heading => ({
                type: "ObjectExpression",
                properties: Object.entries(heading).map(([key, value]) => ({
                  type: "Property",
                  key: { type: "Identifier", name: key },
                  value: { type: "Literal", value },
                  kind: "init",
                  method: false,
                  shorthand: false,
                  computed: false,
                })),
              })),
            },
          },
        ],
      },
    })
  }
}

export const solidMarkdown = (
  options: { rehypePlugins?: PluggableList } = {},
): PluginOption =>
  mdx({
    jsxImportSource: "solid-jsx",
    rehypePlugins: [rehypeHeadings, ...(options.rehypePlugins ?? [])],
    recmaPlugins: [recmaHeadings],
    remarkPlugins: [
      remarkFrontmatter,
      [remarkMdxFrontmatter, { name: "frontmatter" }],
    ],
  })
