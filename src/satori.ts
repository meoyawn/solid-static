import { Buffer } from "node:buffer"
import type satori from "satori"

export interface SatoriImageFont {
  name: string
  src: string
  weight: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900
  style?: "normal" | "italic"
}

export interface SatoriImageOptions {
  element: Parameters<typeof satori>[0]
  fonts: SatoriImageFont[]
  width: number
  height: number
}

export const satoriImagePrefix = "/@solid-static/satori/"
export const satoriImagePattern =
  /(?<origin>https?:\/\/[^/\s"'<>]+)?\/@solid-static\/satori\/(?<token>[A-Za-z0-9_-]+)\.png/g

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function requireOptions(value: unknown): SatoriImageOptions {
  if (
    !isRecord(value) ||
    !isRecord(value.element) ||
    !Number.isInteger(value.width) ||
    typeof value.width !== "number" ||
    value.width < 1 ||
    value.width > 4096 ||
    !Number.isInteger(value.height) ||
    typeof value.height !== "number" ||
    value.height < 1 ||
    value.height > 4096 ||
    !Array.isArray(value.fonts) ||
    value.fonts.length === 0 ||
    !value.fonts.every(
      (font) =>
        isRecord(font) &&
        typeof font.name === "string" &&
        font.name !== "" &&
        typeof font.src === "string" &&
        font.src !== "" &&
        typeof font.weight === "number" &&
        [100, 200, 300, 400, 500, 600, 700, 800, 900].includes(font.weight) &&
        (font.style === undefined ||
          font.style === "normal" ||
          font.style === "italic"),
    )
  ) {
    throw new TypeError(
      "Invalid Satori image options: provide an element, local fonts, and dimensions between 1 and 4096",
    )
  }
  return value as unknown as SatoriImageOptions
}

/** Render a stateless .satori.tsx template to a PNG in the static-site image pipeline. */
export function getSatoriImage(options: SatoriImageOptions): {
  src: string
  width: number
  height: number
} {
  if (typeof document !== "undefined")
    throw new TypeError(
      "getSatoriImage() is only available during server rendering",
    )
  const data = JSON.stringify(
    requireOptions(options),
    (_key, value: unknown) => {
      if (typeof value === "function")
        throw new TypeError(
          "Satori templates must contain only rendered, stateless elements",
        )
      return value
    },
  )
  return {
    src: `${satoriImagePrefix}${Buffer.from(data).toString("base64url")}.png`,
    width: options.width,
    height: options.height,
  }
}

export const parseSatoriImage = (token: string): SatoriImageOptions =>
  requireOptions(JSON.parse(Buffer.from(token, "base64url").toString()))
