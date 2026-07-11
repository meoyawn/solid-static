import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { loadCollections } from "./content.ts"

describe("content collections", () => {
  test("parses YAML timestamps as dates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vite-static-site-content-"))

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
