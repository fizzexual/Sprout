// values.ts — the runtime values of Sprout and the helpers that work on them.
// Shared by the interpreter and the built-in functions.

export type Value = number | string | boolean;

// Turn a value into the text Sprout shows the user.
export function stringify(v: Value): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Object.is(v, -0)) return "0";
  return String(v);
}

// Sprout's notion of "truthy" for conditions: 0, "", and false are false.
export function isTruthy(v: Value): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  return true;
}

// A friendly, human name for a value's type (used in error messages).
export function typeName(v: Value): string {
  if (typeof v === "number") return "a number";
  if (typeof v === "string") return "text";
  return "a true/false value";
}
