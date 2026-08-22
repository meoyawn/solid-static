declare module "turndown" {
  interface TurndownOptions {
    [key: string]: unknown
  }

  type Filter =
    | string
    | readonly string[]
    | ((node: Element, options: TurndownOptions) => boolean)

  interface Rule {
    filter: Filter
    replacement: (
      content: string,
      node: Element,
      options: TurndownOptions,
    ) => string
  }

  export default class TurndownService {
    constructor(options?: TurndownOptions)
    addRule(key: string, rule: Rule): this
    keep(filter: Filter): this
    remove(filter: Filter): this
    turndown(input: string): string
    use(plugin: (service: TurndownService) => void): this
  }
}

declare module "turndown-plugin-gfm" {
  import TurndownService from "turndown"

  export const gfm: (service: TurndownService) => void
}
