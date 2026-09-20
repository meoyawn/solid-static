import { describe, expect, test } from "vitest"
import { createHtmlMarkdownProcessor } from "./markdown.ts"

describe("Markdown headings", () => {
  test("renders unique anchors and matching metadata for formatted and repeated headings", async () => {
    const result = await createHtmlMarkdownProcessor().process(
      "## Start **here**\n### Audio `RSS` & café\n## Start here\n## Start here-1\n## Start here\n## 日本語\n##\n",
    )

    expect(result.data.headings).toEqual([
      { depth: 2, slug: "start-here", text: "Start here" },
      { depth: 3, slug: "audio-rss--café", text: "Audio RSS & café" },
      { depth: 2, slug: "start-here-1", text: "Start here" },
      { depth: 2, slug: "start-here-1-1", text: "Start here-1" },
      { depth: 2, slug: "start-here-2", text: "Start here" },
      { depth: 2, slug: "日本語", text: "日本語" },
      { depth: 2, slug: "section", text: "" },
    ])
    expect(String(result)).toContain('<h2 id="start-here">Start <strong>here</strong></h2>')
    for (const heading of result.data.headings ?? []) {
      expect(String(result)).toContain(`<h${heading.depth} id="${heading.slug}">`)
    }
  })

  test("keeps numbering local to each document when a processor is reused concurrently", async () => {
    const processor = createHtmlMarkdownProcessor()
    const files = await Promise.all([
      processor.process("## Audio\n## Audio"),
      processor.process("## Audio"),
      processor.process("No headings."),
    ])

    expect(files.map(file => file.data.headings)).toEqual([
      [
        { depth: 2, slug: "audio", text: "Audio" },
        { depth: 2, slug: "audio-1", text: "Audio" },
      ],
      [{ depth: 2, slug: "audio", text: "Audio" }],
      [],
    ])
  })
})
