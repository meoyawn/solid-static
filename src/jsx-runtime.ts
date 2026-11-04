import type { JSX } from "solid-js"

export interface RenderElement {
  type: "solid-static:element"
  tagName: string
  props: Record<string, unknown>
}

export interface RenderComponent {
  type: "solid-static:component"
  render: () => unknown
}

export function jsx(type: unknown, props: Record<string, unknown> | null): JSX.Element {
  if (typeof type === "string") {
    const node: RenderElement = {
      type: "solid-static:element",
      tagName: type,
      props: props ?? {},
    }
    return node as unknown as JSX.Element
  }

  if (typeof type === "function") {
    return deferred(() => type(props ?? {}))
  }

  throw new TypeError("A static-site element must have a tag name or component")
}

export const jsxs = jsx
export const jsxDEV = jsx

export const Fragment = (props: { children?: JSX.Element }): JSX.Element => props.children

export function deferred(render: () => unknown): JSX.Element {
  const node: RenderComponent = { type: "solid-static:component", render }
  return node as unknown as JSX.Element
}
