

export function summarize(text: string, max: number): string {
  const singleLine = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}...` : singleLine;
}


export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
