/** A JSON value. `JSON.parse` and the JSONC parser produce only these shapes. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject

/** A JSON object. Each property value is a JSON value. */
export type JsonObject = { [key: string]: JsonValue }

/** Decode one JSON document. Invalid JSON throws `SyntaxError`. */
export function parseJsonValue(text: string): JsonValue {
  // SAFETY: JSON.parse returns one JSON value or throws SyntaxError.
  return JSON.parse(text) as JsonValue
}

export function isString(value: unknown): value is string {
  return typeof value === "string"
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number"
}

/** True for non-null objects other than arrays. */
export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stringField(record: JsonObject, key: string): string | undefined {
  const value = record[key]

  return isString(value) ? value : undefined
}

export function requiredString(record: JsonObject, key: string, label: string): string {
  const value = stringField(record, key)

  if (!value || value.trim() === "") {
    throw new Error(`${label} is missing ${key}.`)
  }

  return value
}
