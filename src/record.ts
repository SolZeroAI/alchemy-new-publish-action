export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

export function requiredString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = stringField(record, key)
  if (!value || value.trim() === "") {
    throw new Error(`${label} is missing ${key}.`)
  }
  return value
}
