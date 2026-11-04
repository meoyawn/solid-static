import { fileURLToPath } from "node:url"
import { transformWithOxc, type Plugin } from "vite"

const runtime = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./jsx-runtime.ts" : "./jsx-runtime.js", import.meta.url))
const renderer = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./render.tsx" : "./render.jsx", import.meta.url))
const image = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./image.tsx" : "./image.jsx", import.meta.url))
const satori = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./satori.ts" : "./satori.js", import.meta.url))
const collections = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./runtime.ts" : "./runtime.js", import.meta.url))

/** Compile server JSX to render nodes while Vite's Solid plugin owns browser JSX. */
export function renderJsx(): Plugin {
  return {
    name: "solid-static-render-jsx",
    enforce: "pre",
    config() {
      return {
        resolve: {
          alias: {
            "solid-static/jsx-runtime": runtime,
            "solid-static/jsx-dev-runtime": runtime,
            "solid-jsx/jsx-runtime": runtime,
            "solid-jsx/jsx-dev-runtime": runtime,
            "solid-static/render": renderer,
            "solid-static/image": image,
            "solid-static/satori": satori,
            "solid-static/runtime": collections,
          },
        },
      }
    },
    transform: {
      filter: { id: /\.[jt]sx(?:\?|$)/ },
      handler(source, id, options) {
        if (!options?.ssr) return undefined
        return transformWithOxc(source, id, {
          jsx: { runtime: "automatic", importSource: /\.satori\.tsx(?:\?|$)/.test(id) ? "satori/jsx" : "solid-static", development: false },
        })
      },
    },
  }
}
