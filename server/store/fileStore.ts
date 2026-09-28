/** A file-name-safe key (owner names in cache paths). */
export function safeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-_]+/gi, "-");
}
