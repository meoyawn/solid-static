import { Buffer } from "node:buffer"
import { describe, expect, test } from "vitest"
import {
  generatedImagePathPrefix,
  getImage,
  parseGeneratedImageRequest,
} from "./get-image.ts"

describe("getImage", () => {
  test("returns an Astro-compatible result for a Vite image URL", async () => {
    const result = await getImage({
      format: "png",
      height: 630,
      quality: "high",
      src: "/assets/social-preview-source.svg",
      width: 1200,
    })

    expect(result.attributes).toEqual({ height: 630, width: 1200 })
    expect(result.options).toEqual({
      format: "png",
      height: 630,
      quality: "high",
      src: "/assets/social-preview-source.svg",
      width: 1200,
    })
    expect(result.rawOptions).toEqual({
      format: "png",
      height: 630,
      quality: "high",
      src: "/assets/social-preview-source.svg",
      width: 1200,
    })
    expect(result.src.startsWith(generatedImagePathPrefix)).toEqual(true)
    expect(result.srcSet).toEqual({ attribute: "", values: [] })

    expect(
      parseGeneratedImageRequest(
        result.src.slice(generatedImagePathPrefix.length),
      ),
    ).toEqual({
      format: "png",
      height: 630,
      quality: "high",
      sourceUrl: "/assets/social-preview-source.svg",
      width: 1200,
    })
  })

  test("infers dimensions from imported image metadata", async () => {
    const result = await getImage({
      src: {
        format: "png",
        height: 900,
        src: "/assets/source.png",
        width: 1600,
      },
      width: 800,
    })

    expect(result.attributes).toEqual({ height: 450, width: 800 })
    expect(result.options).toEqual({
      format: "webp",
      height: 450,
      src: {
        format: "png",
        height: 900,
        src: "/assets/source.png",
        width: 1600,
      },
      width: 800,
    })
  })

  test("rejects invalid transforms and markers", async () => {
    await expect(
      getImage({ src: "/assets/source.png", width: 0 }),
    ).rejects.toThrow("positive integer")
    expect(() =>
      parseGeneratedImageRequest(
        Buffer.from("not-json").toString("base64url"),
      ),
    ).toThrow("Invalid getImage() request")
  })
})
