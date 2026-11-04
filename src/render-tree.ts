import type { Element, Properties, Root, RootContent } from "hast"
import { toHtml } from "hast-util-to-html"
import { createRoot, getOwner, runWithOwner, type Owner } from "solid-js"

declare module "hast" {
  interface ElementData {
    originalImageUrl?: string
  }
  interface RootContentMap {
    raw: { type: "raw"; value: string }
  }
  interface ElementContentMap {
    raw: { type: "raw"; value: string }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function styleText(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!isRecord(value)) return undefined
  return Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null && item !== false)
    .map(([name, item]) => `${name.startsWith("--") ? name : name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}:${String(item)}`)
    .join(";")
}

function propertiesFor(props: Record<string, unknown>): Properties {
  const properties: Properties = {}
  for (const [name, original] of Object.entries(props)) {
    if (["children", "innerHTML", "textContent", "ref", "classList"].includes(name) || /^on[A-Z:]/.test(name)) continue
    const value: unknown = typeof original === "function" ? original() : original
    if (name === "style") {
      const style = styleText(value)
      if (style !== undefined) properties.style = style
    } else if ((name === "class" || name === "className") && typeof value === "string") {
      properties.className = value.split(/\s+/).filter(Boolean)
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
      properties[name] = value
    } else if (Array.isArray(value) && value.every(item => typeof item === "string" || typeof item === "number")) {
      properties[name] = value
    } else {
      throw new TypeError(`Unsupported static HTML attribute ${name}`)
    }
  }
  if (isRecord(props.classList)) {
    const classes = Object.entries(props.classList).filter(([, enabled]) => enabled).map(([name]) => name)
    const existing = properties.className ?? properties.class
    properties.className = [...(Array.isArray(existing) ? existing : String(existing ?? "").split(/\s+/)), ...classes].map(String).filter(Boolean)
    delete properties.class
  }
  return properties
}

async function resolveValue(value: unknown, owner: Owner | null): Promise<RootContent[]> {
  if (value === undefined || value === null || typeof value === "boolean") return []
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return [{ type: "text", value: String(value) }]
  }
  if (typeof value === "function") return resolveValue(runWithOwner(owner, () => value()), owner)
  if (Array.isArray(value)) {
    const children: RootContent[] = []
    for (const child of value) children.push(...await resolveValue(child, owner))
    return children
  }
  if (!isRecord(value)) throw new TypeError("Unsupported static-site child")
  if (typeof value.then === "function") return resolveValue(await value, owner)
  if (value.type === "solid-static:component" && typeof value.render === "function") {
    const render = value.render
    return resolveValue(runWithOwner(owner, () => render()), owner)
  }
  if (value.type === "solid-static:element" && typeof value.tagName === "string" && isRecord(value.props)) {
    const props = value.props
    const children = props.innerHTML !== undefined
      ? [{ type: "raw" as const, value: String(props.innerHTML) }]
      : await resolveValue(props.textContent ?? props.children, owner)
    return [{ type: "element", tagName: value.tagName, properties: propertiesFor(props), children: children as Element["children"] }]
  }
  if (value.type === "root" && Array.isArray(value.children)) return resolveValue(value.children, owner)
  if (value.type === "element" && typeof value.tagName === "string" && isRecord(value.properties) && Array.isArray(value.children)) {
    return [{
      type: "element",
      tagName: value.tagName,
      properties: { ...value.properties } as Properties,
      children: await resolveValue(value.children, owner) as Element["children"],
      ...(isRecord(value.data) ? { data: { ...value.data } } : {}),
    }]
  }
  if ((value.type === "text" || value.type === "raw" || value.type === "comment") && typeof value.value === "string") {
    return [{ type: value.type, value: value.value }]
  }
  if (typeof value.t === "string") return [{ type: "raw", value: value.t }]
  throw new TypeError("Unsupported static-site render node")
}

export function renderTree(value: unknown): Promise<Root> {
  return createRoot(dispose => {
    const owner = getOwner()
    return resolveValue(value, owner)
      .then(children => ({ type: "root" as const, children }))
      .finally(dispose)
  })
}

export const htmlForTree = (tree: Root): string => toHtml(tree, { allowDangerousHtml: true })
