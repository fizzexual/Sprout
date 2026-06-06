// bloom.ts — Bloom is Sprout's own styling language (its version of CSS).
//
// A .bloom file describes how widgets look. The SAME Bloom theme is used by
// the native GUI window and by the web server, so a Sprout app looks the same
// whether it runs as a window or a website.
//
// Example (counter.bloom):
//
//   window:                ~ the whole window/page
//       background: #1a1030
//       text: #f0e9ff
//       font: Segoe UI 14
//
//   button:                ~ all buttons
//       background: #8a5cff
//       text: #ffffff
//       rounded: 12
//
//   #display:              ~ one widget, by its id
//       size: 26

export interface Style {
  [prop: string]: string;
}

export interface Theme {
  selectors: Record<string, Style>;
}

// Parse Bloom source into a theme (a map of selector -> properties).
export function parseBloom(source: string): Theme {
  const selectors: Record<string, Style> = {};
  let current: Style | undefined;

  for (const raw of source.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (line.trim() === "") continue;

    const isIndented = /^\s/.test(raw);
    if (!isIndented) {
      // A selector line: "button:" or "#display:"
      const name = line.trim().replace(/:\s*$/, "").trim();
      if (name) current = selectors[name] ?? (selectors[name] = {});
    } else if (current) {
      // A property line: "background: #8a5cff"
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const prop = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (prop) current[prop] = value;
    }
  }
  return { selectors };
}

function stripComment(line: string): string {
  const i = line.indexOf("~");
  return i === -1 ? line : line.slice(0, i);
}

// The style for a widget: its kind's style, then its #id style layered on top.
export function styleFor(theme: Theme, kind: string, id: string): Style {
  return { ...(theme.selectors[kind] ?? {}), ...(theme.selectors["#" + id] ?? {}) };
}

export function windowStyle(theme: Theme): Style {
  return theme.selectors["window"] ?? {};
}

// Split a font value like "Segoe UI 14" into family + optional size.
export function fontParts(value: string): { family: string; size?: number } {
  const m = value.match(/^(.*?)(?:\s+(\d+))?$/);
  if (!m) return { family: value.trim() || "Segoe UI" };
  return { family: (m[1].trim() || "Segoe UI"), size: m[2] ? Number(m[2]) : undefined };
}

export const DEFAULT_BLOOM = `window:
    background: #0f1410
    text: #e6efe6
    font: Segoe UI 13

label:
    size: 16

button:
    background: #7bd88f
    text: #08120a
    rounded: 10

field:
    background: #161d17
    text: #e6efe6
    border: #28321f
`;

export function defaultTheme(): Theme {
  return parseBloom(DEFAULT_BLOOM);
}
