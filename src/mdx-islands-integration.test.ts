import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { load as loadHtml } from "cheerio"
import { build } from "vite"
import { describe, expect, test } from "vitest"
import { staticSite } from "./index.ts"
import { createHtmlMarkdownProcessor, solidMarkdown } from "./markdown.ts"

describe("MDX client islands", () => {
  test("compiles MDX pages and collection bodies with headings and browser-only entries", async () => {
    const root = await mkdtemp(join(process.cwd(), ".solid-static-mdx-"))
    try {
      await mkdir(join(root, "src/pages"), { recursive: true })
      await mkdir(join(root, "src/content"), { recursive: true })
      await Promise.all([
        writeFile(join(root, "src/layout.tsx"), `
export default props => <html><head></head><body>{props.children}</body></html>
`),
        writeFile(join(root, "src/pages/page.mdx"), `---
layout: ../layout.tsx
---
import island from "../island.ts?island"

## Install

<a data-installer href="/releases/">Download</a>
<script type="module" src={island} />
`),
        writeFile(join(root, "src/content/guide.mdx"), `---
title: Guide
---
import island from "../island.ts?island"

## Install

<a data-installer href="/releases/">Download</a>
<script type="module" src={island} />

## Install
`),
        writeFile(join(root, "src/pages/index.tsx"), `
import { getCollection } from "solid-static/runtime"
export default () => {
  const entry = getCollection("guides")[0]
  return <html><head></head><body>
    <nav>{entry.rendered.headings.map(heading => <a href={"#" + heading.slug}>{heading.text}</a>)}</nav>
    <article innerHTML={entry.rendered.html} />
  </body></html>
}
`),
        writeFile(join(root, "src/island.ts"), `
const installer = document.querySelector("[data-installer]")
installer.setAttribute("href", "/latest-installer.dmg")
`),
      ])
      await build({
        root,
        logLevel: "silent",
        plugins: [staticSite({
          collections: { guides: { directory: "src/content", pattern: /\.mdx$/u } },
          i18n: { defaultLocale: "en", locales: ["en"], routing: { prefixDefaultLocale: false } },
          integrations: [solidMarkdown()],
          markdown: { processor: createHtmlMarkdownProcessor() },
          trailingSlash: "always",
        })],
      })
      const documents = await Promise.all(["index.html", "page/index.html"].map(async fileName =>
        loadHtml(await readFile(join(root, "dist", fileName), "utf8")),
      ))
      for (const $ of documents) {
        expect($("[data-installer]")).toHaveLength(1)
        const script = $("script[type=module]").attr("src")
        expect(script).toMatch(/^\/assets\/islands\/[^/]+\.js$/u)
        await readFile(join(root, "dist", script!.slice(1)))
      }
      const collection = documents[0]!
      expect(collection("article h2").map((_index, element) => collection(element).attr("id")).get()).toEqual(["install", "install-1"])
      expect(collection("nav a").map((_index, element) => collection(element).attr("href")).get()).toEqual(["#install", "#install-1"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
