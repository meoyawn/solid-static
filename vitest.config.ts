import solid from "vite-plugin-solid"
import { defineConfig } from "vitest/config"
import { renderJsx } from "./src/render-jsx.ts"

export default defineConfig({
  plugins: [renderJsx(), solid({ ssr: true, hot: false })],
})
