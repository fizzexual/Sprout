// explore.ts — "Verify API": given a JSON reply, list every value you can read,
// as `path = value` lines. The path on the left is exactly what you pass to
// jsonpick(...).

export function describeJson(text: string): string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const t = text.trim();
    return t.length > 400 ? t.slice(0, 400) + " …" : t || "(empty reply)";
  }
  const lines: string[] = [];
  walk(data, "", lines, 0);
  return lines.length ? lines.join("\n") : "(no fields)";
}

function walk(val: unknown, path: string, lines: string[], depth: number): void {
  if (depth > 6) {
    lines.push(`${path} = …`);
    return;
  }
  if (Array.isArray(val)) {
    lines.push(`${path || "(top)"} = [a list of ${val.length}]`);
    if (val.length > 0) walk(val[0], `${path}.0`, lines, depth + 1);
  } else if (val !== null && typeof val === "object") {
    for (const key of Object.keys(val as Record<string, unknown>)) {
      const child = (val as Record<string, unknown>)[key];
      const p = path ? `${path}.${key}` : key;
      if (child !== null && typeof child === "object") walk(child, p, lines, depth + 1);
      else lines.push(`${p} = ${preview(child)}`);
    }
  } else {
    lines.push(`${path || "(value)"} = ${preview(val)}`);
  }
}

function preview(v: unknown): string {
  if (typeof v === "string") return `"${v.length > 70 ? v.slice(0, 70) + "…" : v}"`;
  if (v === null) return "nothing";
  return String(v);
}
