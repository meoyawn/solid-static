import solid from "@solidjs/vite-plugin"
import { defineConfig } from "vitest/config"
import { renderJsx } from "./src/render-jsx.ts"

export default defineConfig({
  plugins: [renderJsx(), solid({ ssr: true, refresh: false })],
  // @solidjs/vite-plugin applies browser resolve conditions to tests unless the environment is explicitly node.
  test: { environment: "node" },
})
