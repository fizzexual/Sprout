// builtins.ts — Sprout's small standard library of built-in functions.
//
// These are the functions you can call without defining them, like
// sqrt(16) or max(3, 9). Each one validates its arguments and raises the
// same friendly errors as the rest of the language.

import { LangError } from "../lang/errors.ts";
import type { Value } from "./values.ts";
import { NONE, typeName, SList, SMap, equalValues, stringify } from "./values.ts";
import { apiPoints, describeJson } from "./explore.ts";

export interface CallSite {
  line: number;
  col: number;
}

export const BUILTIN_NAMES = [
  "abs", "round", "floor", "ceil", "sqrt",
  "min", "max",
  "length", "upper", "lower", "jsonpick", "explore", "get_api_points",
  "random", "number",
  // collections (v0.5)
  "add", "contains", "keys", "range", "first", "last",
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
    case "length": {
      exactly(name, args, 1, site);
      const v = args[0];
      if (v instanceof SList) return v.items.length;
      if (v instanceof SMap) return v.entries.size;
      if (typeof v === "string") return v.length;
      throw new LangError("Type", `'length' needs text, a list, or a map, but got ${typeName(v)}.`, site.line, site.col, 'Like: length("hi")  or  length([1, 2, 3])');
    }
    case "add": {
      exactly(name, args, 2, site);
      const list = args[0];
      if (!(list instanceof SList)) throw new LangError("Type", `'add' needs a list for its first value, but got ${typeName(list)}.`, site.line, site.col, "Like: add(things, 4)");
      list.items.push(args[1]);
      return list;
    }
    case "contains": {
      exactly(name, args, 2, site);
      const c = args[0];
      if (c instanceof SList) return c.items.some((x) => equalValues(x, args[1]));
      if (c instanceof SMap) return c.entries.has(stringify(args[1]));
      if (typeof c === "string") return c.includes(stringify(args[1]));
      throw new LangError("Type", `'contains' needs a list, map, or text, but got ${typeName(c)}.`, site.line, site.col, "Like: contains([1, 2, 3], 2)");
    }
    case "keys": {
      exactly(name, args, 1, site);
      const m = args[0];
      if (!(m instanceof SMap)) throw new LangError("Type", `'keys' needs a map, but got ${typeName(m)}.`, site.line, site.col, 'Like: keys({name: "Sam"})');
      return new SList([...m.entries.keys()]);
    }
    case "range": {
      atLeast(name, args, 1, site);
      if (args.length > 2) throw new LangError("Type", "'range' takes 1 or 2 numbers.", site.line, site.col, "Like: range(5)  or  range(2, 6)");
      const a = num(args[0], name, 0, site);
      const start = args.length === 2 ? a : 0;
      const stop = args.length === 2 ? num(args[1], name, 1, site) : a;
      const out: Value[] = [];
      for (let i = Math.floor(start); i < Math.floor(stop); i++) out.push(i);
      return new SList(out);
    }
    case "first": case "last": {
      exactly(name, args, 1, site);
      const list = args[0];
      if (!(list instanceof SList)) throw new LangError("Type", `'${name}' needs a list, but got ${typeName(list)}.`, site.line, site.col, `Like: ${name}([1, 2, 3])`);
      if (list.items.length === 0) return NONE;
      return name === "first" ? list.items[0] : list.items[list.items.length - 1];
    }
    case "upper": exactly(name, args, 1, site); return text(args[0], name, 0, site).toUpperCase();
    case "lower": exactly(name, args, 1, site); return text(args[0], name, 0, site).toLowerCase();
    case "random": exactly(name, args, 0, site); return Math.random();
    case "number": {
      // Turn text into a number (handy after ask). Gives `nothing` if it isn't one.
      exactly(name, args, 1, site);
      const v = args[0];
      if (typeof v === "number") return v;
      if (typeof v === "string") { const n = Number(v.trim()); return v.trim() !== "" && !Number.isNaN(n) ? n : NONE; }
      return NONE;
    }
    case "jsonpick": {
      exactly(name, args, 2, site);
      const src = text(args[0], name, 0, site);
      const path = text(args[1], name, 1, site);
      let cur: unknown;
      try {
        cur = JSON.parse(src);
      } catch {
        return NONE;
      }
      for (const part of path.split(".")) {
        if (cur !== null && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[part];
        } else {
          return NONE;
        }
      }
      if (typeof cur === "number" || typeof cur === "string" || typeof cur === "boolean") return cur;
      if (cur === null || cur === undefined) return NONE;
      return JSON.stringify(cur);
    }
    case "explore": {
      exactly(name, args, 1, site);
      return describeJson(text(args[0], name, 0, site));
    }
    case "get_api_points": {
      exactly(name, args, 1, site);
      return apiPoints(text(args[0], name, 0, site));
    }
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
  if (name === "upper" || name === "lower") return `${name}("hello")`;
  if (name === "length") return 'length([1, 2, 3])';
  if (name === "add") return "add(things, 4)";
  if (name === "contains") return "contains(things, 2)";
  if (name === "keys") return 'keys({name: "Sam"})';
  if (name === "range") return "range(5)";
  if (name === "first" || name === "last") return `${name}(things)`;
  if (name === "number") return 'number("42")';
  if (name === "jsonpick") return 'jsonpick(text, "key")';
  if (name === "explore") return "explore(response)";
  if (name === "get_api_points") return "get_api_points(response)";
  if (name === "random") return "random()";
  return `${name}(16)`;
}
