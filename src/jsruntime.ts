// src/jsruntime.ts — the tiny runtime for COMPILED Sprout (`sprout build`).
//
// `sprout build x.sprout` turns a program into plain JavaScript that imports the
// helpers below and runs on V8 directly — much faster than the interpreter. These
// helpers reuse the interpreter's OWN value types and builtins (values.ts /
// builtins.ts), so a compiled program behaves EXACTLY like `sprout run`.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { NONE, SList, SMap, stringify, isTruthy, equalValues, typeName } from "./values.ts";
import { callBuiltin } from "./builtins.ts";

export { NONE, SList, SMap };

const SITE = { line: 1, col: 1 };
function err(msg: string): never { throw new Error(msg); }

export function _show(...args: any[]): void { console.log(args.map((a) => stringify(a)).join(" ")); }

// + joins text, adds numbers, or concatenates two lists (same as the interpreter).
export function _add(a: any, b: any): any {
  if (typeof a === "string" || typeof b === "string") return stringify(a) + stringify(b);
  if (typeof a === "number" && typeof b === "number") return a + b;
  if (a instanceof SList && b instanceof SList) return new SList([...a.items, ...b.items]);
  err(`I can't add ${typeName(a)} and ${typeName(b)}.`);
}
export function _sub(a: any, b: any): any { if (typeof a === "number" && typeof b === "number") return a - b; err(`I can't subtract ${typeName(a)} and ${typeName(b)}.`); }
export function _mul(a: any, b: any): any { if (typeof a === "number" && typeof b === "number") return a * b; err(`I can't multiply ${typeName(a)} and ${typeName(b)}.`); }
export function _div(a: any, b: any): any { if (typeof a === "number" && typeof b === "number") { if (b === 0) err("You tried to divide by zero, which has no answer."); return a / b; } err(`I can't divide ${typeName(a)} and ${typeName(b)}.`); }
export function _mod(a: any, b: any): any { if (typeof a === "number" && typeof b === "number") { if (b === 0) err("You tried to take a remainder with zero."); return a % b; } err(`I can't take a remainder of ${typeName(a)} and ${typeName(b)}.`); }
export function _neg(a: any): any { if (typeof a === "number") return -a; err(`I can only put a minus sign in front of a number, not ${typeName(a)}.`); }

function cmp(a: any, b: any, op: string): boolean {
  if ((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string")) {
    return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
  }
  err(`I can't compare ${typeName(a)} with ${typeName(b)}.`);
}
export function _lt(a: any, b: any): boolean { return cmp(a, b, "<"); }
export function _le(a: any, b: any): boolean { return cmp(a, b, "<="); }
export function _gt(a: any, b: any): boolean { return cmp(a, b, ">"); }
export function _ge(a: any, b: any): boolean { return cmp(a, b, ">="); }
export function _eq(a: any, b: any): boolean { return equalValues(a, b); }
export function _ne(a: any, b: any): boolean { return !equalValues(a, b); }
export function _truthy(v: any): boolean { return isTruthy(v); }
export function _not(v: any): boolean { return !isTruthy(v); }

export function _index(t: any, i: any): any {
  if (t instanceof SList) { if (typeof i !== "number") err("A list is numbered, so its index must be a number."); const k = Math.floor(i); return k >= 0 && k < t.items.length ? t.items[k] : NONE; }
  if (t instanceof SMap) { const key = stringify(i); return t.entries.has(key) ? t.entries.get(key) : NONE; }
  if (typeof t === "string") { if (typeof i !== "number") err("Text is numbered, so its index must be a number."); const k = Math.floor(i); return k >= 0 && k < t.length ? t[k] : NONE; }
  err(`I can only look inside a list, a map, or text with [...], not ${typeName(t)}.`);
}
export function _iset(coll: any, i: any, v: any): void {
  if (coll instanceof SList) { if (typeof i !== "number") err("A list is numbered, so its index must be a number."); const k = Math.floor(i); if (k < 0 || k > coll.items.length) err(`That spot (${k}) is outside the list (it has ${coll.items.length}).`); coll.items[k] = v; return; }
  if (coll instanceof SMap) { coll.entries.set(stringify(i), v); return; }
  err(`I can only set an item inside a list or a map, not ${typeName(coll)}.`);
}
export function _iter(coll: any): any[] {
  if (coll instanceof SList) return coll.items.slice();
  if (coll instanceof SMap) return [...coll.entries.keys()];
  if (typeof coll === "string") return [...coll];
  err(`'for each' needs a list, a map, or text to go through, but got ${typeName(coll)}.`);
}
export function _count(n: any): number { if (typeof n !== "number") err(`'repeat ... times' needs a number, but got ${typeName(n)}.`); return Math.floor(n); }
export function _smap(pairs: [string, any][]): SMap { return new SMap(new Map(pairs)); }

// Core builtins (length/upper/round/range/add/keys/...) — routed through the
// interpreter's own callBuiltin so they behave identically.
export function _b(name: string, args: any[]): any { return callBuiltin(name, args, SITE); }
