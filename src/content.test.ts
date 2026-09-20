import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { loadCollections } from "./content.ts"
import { createHtmlMarkdownProcessor } from "./markdown.ts"

describe("content collections", () => {
  test("carries rendered heading anchors into collection entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "solid-static-headings-"))
    try {
      await writeFile(join(directory, "guide.md"), "---\ntitle: Guide\n---\n## Listen\n### Share\n")
      const collections = await loadCollections(
        { guides: { directory, pattern: /\.md$/u } },
        createHtmlMarkdownProcessor(),
      )
      expect(collections.guides?.[0]?.rendered).toEqual({
        html: '<h2 id="listen">Listen</h2>\n<h3 id="share">Share</h3>',
        headings: [
          { depth: 2, slug: "listen", text: "Listen" },
          { depth: 3, slug: "share", text: "Share" },
        ],
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("parses YAML timestamps as dates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "solid-static-content-"))

    try {
      await writeFile(
        join(directory, "article.md"),
        "---\npublished_at: 2026-05-29\n---\nArticle\n",
      )

      const collections = await loadCollections({
        writing: { directory, pattern: /\.md$/ },
      })

      expect(collections).toEqual({
        writing: [
          {
            body: "Article\n",
            data: { published_at: new Date("2026-05-29T00:00:00.000Z") },
            id: "article",
          },
        ],
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
