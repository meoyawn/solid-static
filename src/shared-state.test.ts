import { describe, expect, test } from "vitest"
import type { RenderEnvironment } from "./render-environment.ts"

type RenderEnvironmentModule = typeof import("./render-environment.ts")
type RuntimeModule = typeof import("./runtime.ts")

/**
 * A dependency reinstall can leave the Vite plugin on one installed copy of
 * solid-static while pages re-import another, so each copy is a separate
 * module instance.
 */
const separateCopy = <T>(path: string): Promise<T> =>
  import(/* @vite-ignore */ `${path}?copy=${crypto.randomUUID()}`)

const unused = (): never => {
  throw new Error("Not used by this test")
}

const environment: RenderEnvironment = {
  image: unused,
  islandUrl: unused,
  markdown: unused,
  prepareDocument: unused,
  prepareMarkdown: unused,
  responsiveImage: unused,
  satoriImage: unused,
}

describe("state shared across installed copies", () => {
  test("pages see the render environment the plugin's copy entered", async () => {
    const plugin = await separateCopy<RenderEnvironmentModule>("./render-environment.ts")
    const page = await separateCopy<RenderEnvironmentModule>("./render-environment.ts")

    expect(page).not.toBe(plugin)
    expect(plugin.withRenderEnvironment(environment, () => page.renderEnvironment()))
      .toBe(environment)
  })

  test("pages see collections the plugin's copy loaded", async () => {
    const plugin = await separateCopy<RuntimeModule>("./runtime.ts")
    const page = await separateCopy<RuntimeModule>("./runtime.ts")

    expect(page).not.toBe(plugin)
    plugin.setCollections({ notes: [] })
    expect(page.getCollection("notes")).toEqual([])
  })
})
