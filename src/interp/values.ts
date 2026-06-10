// values.ts — the runtime values of Sprout and the helpers that work on them.
// Shared by the interpreter and the built-in functions.

// "nothing" — what a task gives back when it has no `give`.
export class NoneType {}
export const NONE: NoneType = new NoneType();

// A list — an ordered collection: [1, 2, 3]. Items can be any value.
export class SList {
  items: Value[];
  constructor(items: Value[] = []) { this.items = items; }
}

// A map — named values: {name: "Sam", age: 3}. Keys are always text.
export class SMap {
  entries: Map<string, Value>;
  constructor(entries?: Map<string, Value>) { this.entries = entries ?? new Map(); }
}

export type Value = number | string | boolean | NoneType | SList | SMap;

// Turn a value into the text Sprout shows the user.
export function stringify(v: Value): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v instanceof NoneType) return "nothing";
  if (v instanceof SList) return "[" + v.items.map(inspect).join(", ") + "]";
  if (v instanceof SMap) return "{" + [...v.entries].map(([k, val]) => k + ": " + inspect(val)).join(", ") + "}";
  if (Object.is(v, -0)) return "0";
  return String(v);
}

// Like stringify, but quotes text — used when showing values INSIDE a list or map,
// so [1, "two"] reads clearly.
export function inspect(v: Value): string {
  if (typeof v === "string") return '"' + v + '"';
  return stringify(v);
}

// Sprout's notion of "truthy" for conditions: 0, "", no, nothing, and empty
// lists/maps are false.
export function isTruthy(v: Value): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (v instanceof SList) return v.items.length > 0;
  if (v instanceof SMap) return v.entries.size > 0;
  if (v instanceof NoneType) return false;
  return true;
}

// A friendly, human name for a value's type (used in error messages).
export function typeName(v: Value): string {
  if (typeof v === "number") return "a number";
  if (typeof v === "string") return "text";
  if (typeof v === "boolean") return "a yes/no value";
  if (v instanceof SList) return "a list";
  if (v instanceof SMap) return "a map";
  return "nothing";
}

// Deep value equality (used by == / !=). Lists and maps compare by contents.
export function equalValues(l: Value, r: Value): boolean {
  if (l instanceof SList && r instanceof SList) {
    return l.items.length === r.items.length && l.items.every((x, i) => equalValues(x, r.items[i]));
  }
  if (l instanceof SMap && r instanceof SMap) {
    if (l.entries.size !== r.entries.size) return false;
    for (const [k, v] of l.entries) { if (!r.entries.has(k) || !equalValues(v, r.entries.get(k) as Value)) return false; }
    return true;
  }
  return typeof l === typeof r && l === r;
}
