import { parse } from "parse5"
import type { DefaultTreeAdapterMap } from "parse5"

const isElement = (
  node: DefaultTreeAdapterMap["node"],
): node is DefaultTreeAdapterMap["element"] => "tagName" in node

const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")

const socialUrlProperties = new Set([
  "og:url",
  "og:image",
  "og:image:url",
  "og:image:secure_url",
  "og:audio",
  "og:audio:url",
  "og:audio:secure_url",
  "og:video",
  "og:video:url",
  "og:video:secure_url",
  "twitter:image",
  "twitter:image:src",
])

export function withPageMetadata(html: string, pageUrl: string): string {
  const document = parse(html, { sourceCodeLocationInfo: true })
  const root = document.childNodes.filter(isElement).find(node => node.tagName === "html")
  const head = root?.childNodes.filter(isElement).find(node => node.tagName === "head")
  const headEnd = head?.sourceCodeLocation?.endTag?.startOffset

  if (head === undefined || headEnd === undefined) {
    return html
  }

  const edits: { start: number; end: number; value: string }[] = []
  let hasOpenGraph = false
  let hasOpenGraphUrl = false

  for (const element of head.childNodes.filter(isElement)) {
    if (element.tagName !== "meta" && element.tagName !== "link") {
      continue
    }

    const attributes = new Map(element.attrs.map(attribute => [attribute.name, attribute.value]))
    const property = attributes.get("property") ?? attributes.get("name") ?? ""
    const canonical = element.tagName === "link" &&
      attributes.get("rel")?.toLowerCase().split(/\s+/).includes("canonical") === true

    if (element.tagName === "meta" && property.startsWith("og:")) {
      hasOpenGraph = true
      hasOpenGraphUrl ||= property === "og:url"
    }

    if (!canonical && (element.tagName !== "meta" || !socialUrlProperties.has(property))) {
      continue
    }

    const attributeName = canonical ? "href" : "content"
    const value = attributes.get(attributeName)
    const location = element.sourceCodeLocation?.attrs?.[attributeName]

    if (value === undefined || value.trim() === "" || location === undefined) {
      continue
    }

    const url = new URL(value, pageUrl)

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      continue
    }

    edits.push({
      start: location.startOffset,
      end: location.endOffset,
      value: `${attributeName}="${escapeAttribute(url.href)}"`,
    })
  }

  if (hasOpenGraph && !hasOpenGraphUrl) {
    edits.push({
      start: headEnd,
      end: headEnd,
      value: `<meta property="og:url" content="${escapeAttribute(pageUrl)}">`,
    })
  }

  let transformed = html

  for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
    transformed = transformed.slice(0, edit.start) + edit.value + transformed.slice(edit.end)
  }

  return transformed
}
