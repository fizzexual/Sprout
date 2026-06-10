// src/compile/compile.ts — compile a Sprout program to JavaScript (`sprout build`).
//
// The compiled program imports src/compile/jsruntime.ts (which reuses the interpreter's
// own value types + builtins), so it behaves EXACTLY like `sprout run` — just
// much faster, because V8 runs it as real JS instead of walking the AST.
//
// The "fast build" covers the CORE language (variables, math, text, conditions,
// loops, lists/maps, for-each, tasks, and the core builtins). A program that uses
// a library (`use`), a styled GUI, or a capability builtin (get/ask/secret/…) is
// refused with a friendly note to run it with `sprout run` instead.

import type { Stmt, Expr } from "../lang/ast.ts";
import { BUILTIN_NAMES } from "../interp/builtins.ts";

const BUILTIN = new Set(BUILTIN_NAMES);
const BINOP: Record<string, string> = {
  "+": "_add", "-": "_sub", "*": "_mul", "/": "_div", "%": "_mod",
  "<": "_lt", "<=": "_le", ">": "_gt", ">=": "_ge", "==": "_eq", "!=": "_ne",
};

export function compile(program: Stmt[], runtimeUrl: string): { js: string } | { error: string } {
  const tasks = new Set<string>();
  for (const s of program) if (s.type === "Task") tasks.add(s.name);

  // --- 1) refuse what the fast build can't do yet (so it's always correct) ---
  let problem: string | null = null;
  const note = (m: string): void => { if (!problem) problem = m; };
  const scanStmts = (stmts: Stmt[]): void => { for (const s of stmts) scanStmt(s); };
  const scanStmt = (s: Stmt): void => {
    switch (s.type) {
      // `use "other.sprout"` is a multi-file import — the builder already merged
      // those files in, so here it's a no-op. Only a LIBRARY use can't compile.
      case "Use": if (!s.name.endsWith(".sprout")) note(`the fast build doesn't support 'use "${s.name}"' yet`); break;
      case "Style": note("the fast build doesn't support styled GUI apps yet"); break;
      case "Make": case "Set": scanExpr(s.value); break;
      case "ExprStmt": scanExpr(s.expr); break;
      case "Show": s.values.forEach(scanExpr); break;
      case "When": s.branches.forEach((b) => { scanExpr(b.cond); scanStmts(b.body); }); if (s.otherwiseBody) scanStmts(s.otherwiseBody); break;
      case "RepeatWhile": scanExpr(s.cond); scanStmts(s.body); break;
      case "RepeatTimes": scanExpr(s.count); scanStmts(s.body); break;
      case "ForEach": scanExpr(s.iter); scanStmts(s.body); break;
      case "IndexSet": scanExpr(s.index); scanExpr(s.value); break;
      case "Task": scanStmts(s.body); break;
      case "Give": if (s.value) scanExpr(s.value); break;
    }
  };
  const scanExpr = (e: Expr): void => {
    switch (e.type) {
      case "Unary": scanExpr(e.operand); break;
      case "Interp": e.parts.forEach(scanExpr); break;
      case "Logical": case "Binary": scanExpr(e.left); scanExpr(e.right); break;
      case "Call": if (!tasks.has(e.name) && !BUILTIN.has(e.name) && e.name !== "ask") note(`the fast build doesn't support '${e.name}' yet`); e.args.forEach(scanExpr); break;
      case "List": e.items.forEach(scanExpr); break;
      case "Map": e.entries.forEach((en) => scanExpr(en.value)); break;
      case "Index": scanExpr(e.target); scanExpr(e.index); break;
    }
  };
  scanStmts(program);
  if (problem) return { error: `${problem} — run this one with:  sprout run` };

  // --- 2) code generation ---
  let loopN = 0;
  const v = (name: string): string => "$" + name;            // dodge JS keywords/globals
  const ind = (n: number): string => "  ".repeat(n);

  // Variable names declared in a scope (Make + ForEach), not descending into
  // tasks. Sprout vars are function-scoped, so we hoist them as one `let`.
  const collectVars = (stmts: Stmt[], out: Set<string>): void => {
    for (const s of stmts) {
      if (s.type === "Make") out.add(s.name);
      else if (s.type === "ForEach") { out.add(s.name); collectVars(s.body, out); }
      else if (s.type === "When") { s.branches.forEach((b) => collectVars(b.body, out)); if (s.otherwiseBody) collectVars(s.otherwiseBody, out); }
      else if (s.type === "RepeatWhile" || s.type === "RepeatTimes") collectVars(s.body, out);
    }
  };

  const genExpr = (e: Expr): string => {
    switch (e.type) {
      case "Number": return JSON.stringify(e.value);
      case "String": return JSON.stringify(e.value);
      case "Interp": return `_str(${e.parts.map(genExpr).join(", ")})`;
      case "Bool": return e.value ? "true" : "false";
      case "Nothing": return "NONE";
      case "Identifier": return v(e.name);
      case "Unary": return e.op === "-" ? `_neg(${genExpr(e.operand)})` : `_not(${genExpr(e.operand)})`;
      case "Logical": return `(_truthy(${genExpr(e.left)}) ${e.op === "and" ? "&&" : "||"} _truthy(${genExpr(e.right)}))`;
      case "Binary": return `${BINOP[e.op]}(${genExpr(e.left)}, ${genExpr(e.right)})`;
      case "Call":
        if (tasks.has(e.name)) return `${v(e.name)}(${e.args.map(genExpr).join(", ")})`;
        if (e.name === "ask") return `_ask([${e.args.map(genExpr).join(", ")}])`;
        return `_b(${JSON.stringify(e.name)}, [${e.args.map(genExpr).join(", ")}])`;
      case "List": return `new SList([${e.items.map(genExpr).join(", ")}])`;
      case "Map": return `_smap([${e.entries.map((en) => `[${JSON.stringify(en.key)}, ${genExpr(en.value)}]`).join(", ")}])`;
      case "Index": return `_index(${genExpr(e.target)}, ${genExpr(e.index)})`;
    }
    return "NONE";
  };

  const genStmts = (stmts: Stmt[], d: number): string => stmts.filter((s) => s.type !== "Task").map((s) => genStmt(s, d)).join("\n");
  const genStmt = (s: Stmt, d: number): string => {
    const pad = ind(d);
    switch (s.type) {
      case "Make": case "Set": return `${pad}${v(s.name)} = ${genExpr(s.value)};`;
      case "Show": return `${pad}_show(${s.values.map(genExpr).join(", ")});`;
      case "ExprStmt": return `${pad}${genExpr(s.expr)};`;
      case "Give": return `${pad}return ${s.value ? genExpr(s.value) : "NONE"};`;
      case "When": {
        let out = `${pad}if (_truthy(${genExpr(s.branches[0].cond)})) {\n${genStmts(s.branches[0].body, d + 1)}\n${pad}}`;
        for (let i = 1; i < s.branches.length; i++) out += ` else if (_truthy(${genExpr(s.branches[i].cond)})) {\n${genStmts(s.branches[i].body, d + 1)}\n${pad}}`;
        if (s.otherwiseBody) out += ` else {\n${genStmts(s.otherwiseBody, d + 1)}\n${pad}}`;
        return out;
      }
      case "RepeatWhile": return `${pad}while (_truthy(${genExpr(s.cond)})) {\n${genStmts(s.body, d + 1)}\n${pad}}`;
      case "RepeatTimes": { const k = `_k${loopN++}`, nn = `_n${loopN++}`; return `${pad}{ const ${nn} = _count(${genExpr(s.count)}); for (let ${k} = 0; ${k} < ${nn}; ${k}++) {\n${genStmts(s.body, d + 1)}\n${pad}} }`; }
      case "ForEach": { const it = `_it${loopN++}`; return `${pad}for (const ${it} of _iter(${genExpr(s.iter)})) {\n${ind(d + 1)}${v(s.name)} = ${it};\n${genStmts(s.body, d + 1)}\n${pad}}`; }
      case "IndexSet": return `${pad}_iset(${v(s.name)}, ${genExpr(s.index)}, ${genExpr(s.value)});`;
    }
    return "";
  };

  const out: string[] = [];
  out.push(`import { NONE, SList, SMap, _show, _add, _sub, _mul, _div, _mod, _neg, _lt, _le, _gt, _ge, _eq, _ne, _truthy, _not, _index, _iset, _iter, _count, _smap, _b, _ask, _str } from ${JSON.stringify(runtimeUrl)};`);
  out.push("");

  // tasks (function declarations hoist, so order/forward-refs are fine)
  for (const s of program) {
    if (s.type !== "Task") continue;
    const locals = new Set<string>();
    collectVars(s.body, locals);
    for (const p of s.params) locals.delete(p);
    out.push(`function ${v(s.name)}(${s.params.map(v).join(", ")}) {`);
    if (locals.size) out.push(`${ind(1)}let ${[...locals].map(v).join(", ")};`);
    out.push(genStmts(s.body, 1));
    out.push(`${ind(1)}return NONE;`);
    out.push("}");
    out.push("");
  }

  // top-level program
  const globals = new Set<string>();
  collectVars(program, globals);
  if (globals.size) out.push(`let ${[...globals].map(v).join(", ")};`);
  out.push("try {");
  out.push(genStmts(program, 1));
  out.push("} catch (e) { console.error('🌱 ' + (e && e.message ? e.message : e)); process.exit(1); }");

  return { js: out.join("\n") + "\n" };
}
