// builtins.ts — Sprout's small standard library of built-in functions.
//
// These are the functions you can call without defining them, like
// sqrt(16) or max(3, 9). Each one validates its arguments and raises the
// same friendly errors as the rest of the language.

import { LangError } from "./errors.ts";
import type { Value } from "./values.ts";
import { typeName } from "./values.ts";

export interface CallSite {
  line: number;
  col: number;
}

export const BUILTIN_NAMES = [
  "abs", "round", "floor", "ceil", "sqrt",
  "min", "max",
  "length", "upper", "lower",
  "random",
];

export function isBuiltin(name: string): boolean {
  return BUILTIN_NAMES.includes(name);
}

export function callBuiltin(name: string, args: Value[], site: CallSite): Value {
  switch (name) {
    case "abs": exactly(name, args, 1, site); return Math.abs(num(args[0], name, 0, site));
    case "round": exactly(name, args, 1, site); return Math.round(num(args[0], name, 0, site));
    case "floor": exactly(name, args, 1, site); return Math.floor(num(args[0], name, 0, site));
    case "ceil": exactly(name, args, 1, site); return Math.ceil(num(args[0], name, 0, site));
    case "sqrt": {
      exactly(name, args, 1, site);
      const x = num(args[0], name, 0, site);
      if (x < 0) {
        throw new LangError("Runtime", "You tried to take the square root of a negative number.", site.line, site.col);
      }
      return Math.sqrt(x);
    }
    case "min": {
      atLeast(name, args, 1, site);
      return args.map((a, i) => num(a, name, i, site)).reduce((p, c) => Math.min(p, c));
    }
    case "max": {
      atLeast(name, args, 1, site);
      return args.map((a, i) => num(a, name, i, site)).reduce((p, c) => Math.max(p, c));
    }
    case "length": exactly(name, args, 1, site); return text(args[0], name, 0, site).length;
    case "upper": exactly(name, args, 1, site); return text(args[0], name, 0, site).toUpperCase();
    case "lower": exactly(name, args, 1, site); return text(args[0], name, 0, site).toLowerCase();
    case "random": exactly(name, args, 0, site); return Math.random();
    default:
      // Unreachable: callers check isBuiltin() first.
      throw new LangError("Name", `I don't know a function called '${name}'.`, site.line, site.col);
  }
}

// --- argument checking -----------------------------------------------------

function num(v: Value, fn: string, i: number, site: CallSite): number {
  if (typeof v !== "number") {
    throw new LangError(
      "Type",
      `'${fn}' needs a number for ${ordinal(i)} value, but got ${typeName(v)}.`,
      site.line,
      site.col,
    );
  }
  return v;
}

function text(v: Value, fn: string, i: number, site: CallSite): string {
  if (typeof v !== "string") {
    throw new LangError(
      "Type",
      `'${fn}' needs text for ${ordinal(i)} value, but got ${typeName(v)}.`,
      site.line,
      site.col,
    );
  }
  return v;
}

function exactly(name: string, args: Value[], n: number, site: CallSite): void {
  if (args.length !== n) {
    throw new LangError(
      "Type",
      `'${name}' needs ${n} ${n === 1 ? "value" : "values"}, but you gave ${args.length}.`,
      site.line,
      site.col,
      `Like: ${exampleCall(name)}`,
    );
  }
}

function atLeast(name: string, args: Value[], n: number, site: CallSite): void {
  if (args.length < n) {
    throw new LangError(
      "Type",
      `'${name}' needs at least ${n} ${n === 1 ? "value" : "values"}, but you gave ${args.length}.`,
      site.line,
      site.col,
      `Like: ${exampleCall(name)}`,
    );
  }
}

function ordinal(i: number): string {
  const words = ["the first", "the second", "the third", "the fourth", "the fifth"];
  return words[i] ?? `value #${i + 1}`;
}

function exampleCall(name: string): string {
  if (name === "min" || name === "max") return `${name}(3, 9, 5)`;
  if (name === "length" || name === "upper" || name === "lower") return `${name}("hello")`;
  if (name === "random") return "random()";
  return `${name}(16)`;
}
