/** Parse JSONC: comments and trailing commas, strings left intact. */
export function parseJsonc(text: string): unknown {
  const json = stripJsonc(text)
  try {
    return JSON.parse(json) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message)
  }
}

export function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text))
}

function stripComments(text: string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (char === '"') {
      const end = readString(text, i)
      out += text.slice(i, end)
      i = end
      continue
    }
    if (char === "/" && text[i + 1] === "/") {
      i += 2
      while (i < text.length && text[i] !== "\n") i += 1
      continue
    }
    if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      if (end === -1) throw new Error("Unterminated block comment")
      const comment = text.slice(i + 2, end)
      const newlines = comment.match(/\n/g)?.length ?? 0
      out += "\n".repeat(newlines)
      i = end + 2
      continue
    }
    out += char ?? ""
    i += 1
  }
  return out
}

function stripTrailingCommas(text: string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (char === '"') {
      const end = readString(text, i)
      out += text.slice(i, end)
      i = end
      continue
    }
    if (char === ",") {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j] ?? "")) j += 1
      if (text[j] === "}" || text[j] === "]") {
        i += 1
        continue
      }
    }
    out += char ?? ""
    i += 1
  }
  return out
}

function readString(text: string, start: number): number {
  let i = start + 1
  while (i < text.length) {
    const char = text[i]
    if (char === "\\") {
      i += 2
      continue
    }
    if (char === '"') return i + 1
    i += 1
  }
  throw new Error("Unterminated string")
}
