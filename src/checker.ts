// checker.ts — verifies a whole Sprout program is correct BEFORE it runs.
//
// It catches the common mistakes up front (instead of partway through running):
//   - using a name that was never created
//   - changing a variable with `set` before `make`-ing it
//   - calling a task or built-in that doesn't exist
//   - calling something with the wrong number of values
//   - `give` outside a task, or a task defined inside another block
//
// It's deliberately CONSERVATIVE: it only reports things that are definitely
// wrong no matter which branch runs, so it won't complain about correct code.

import { LangError } from "./errors.ts";
import type { Expr, Stmt } from "./ast.ts";
import { BUILTIN_NAMES } from "./builtins.ts";
import { GUI_BUILTINS } from "./gui.ts";
import { PERSIST_BUILTINS } from "./storage.ts";
import { NET_BUILTINS } from "./net.ts";
import { SECRET_BUILTINS } from "./secrets.ts";
import { INPUT_BUILTINS } from "./input.ts";

const BUILTIN_ARITY: Record<string, [number, number]> = {
  abs: [1, 1], round: [1, 1], floor: [1, 1], ceil: [1, 1], sqrt: [1, 1],
  length: [1, 1], upper: [1, 1], lower: [1, 1], jsonpick: [2, 2], explore: [1, 1], get_api_points: [1, 1], random: [0, 0],
  min: [1, Infinity], max: [1, Infinity],
  add: [2, 2], contains: [2, 2], keys: [1, 1], range: [1, 2], first: [1, 1], last: [1, 1],
  number: [1, 1],
};
const INPUT_ARITY: Record<string, [number, number]> = {
  ask: [0, 1],
};
const GUI_ARITY: Record<string, [number, number]> = {
  window: [1, 1], server: [1, 1], label: [2, 2], button: [2, 2], field: [1, 2], textof: [1, 1], always_on_top: [0, 1],
};
const PERSIST_ARITY: Record<string, [number, number]> = {
  remember: [2, 2], recall: [1, 2],
};
const NET_ARITY: Record<string, [number, number]> = {
  get: [1, 1], post: [2, 2],
};
const SECRET_ARITY: Record<string, [number, number]> = {
  secret: [1, 1],
};

// Returns every problem found (empty array = the program is good to run).
export function check(program: Stmt[], extra: Set<string> = new Set<string>()): LangError[] {
  const errors: LangError[] = [];

  const taskArity = new Map<string, number>();
  for (const s of program) if (s.type === "Task") taskArity.set(s.name, s.params.length);
  const callable = new Set<string>([...taskArity.keys(), ...BUILTIN_NAMES, ...GUI_BUILTINS, ...PERSIST_BUILTINS, ...NET_BUILTINS, ...SECRET_BUILTINS, ...INPUT_BUILTINS]);

  const globalVars = collectVars(program);

  checkStmts(program, globalVars, false);
  for (const s of program) {
    if (s.type === "Task") {
      const scope = new Set<string>([...globalVars, ...s.params, ...collectVars(s.body)]);
      checkStmts(s.body, scope, true);
    }
  }
  return errors;

  function checkStmts(stmts: Stmt[], vars: Set<string>, inTask: boolean): void {
    for (const st of stmts) checkStmt(st, vars, inTask);
  }

  function checkStmt(st: Stmt, vars: Set<string>, inTask: boolean): void {
    switch (st.type) {
      case "Make":
        checkExpr(st.value, vars);
        return;
      case "Set":
        if (!vars.has(st.name)) {
          errors.push(new LangError("Name", `You're changing '${st.name}', but it was never created.`, st.line, st.col, varHint(st.name, vars) ?? `Create it first with: make ${st.name} = ...`));
        }
        checkExpr(st.value, vars);
        return;
      case "Show":
        st.values.forEach((v) => checkExpr(v, vars));
        return;
      case "When":
        for (const b of st.branches) { checkExpr(b.cond, vars); checkStmts(b.body, vars, inTask); }
        if (st.otherwiseBody) checkStmts(st.otherwiseBody, vars, inTask);
        return;
      case "RepeatWhile":
        checkExpr(st.cond, vars);
        // Catch a loop that can never end: the condition is a value that's always
        // true (yes, a non-zero number, non-empty text). Sprout has no 'break', so
        // this would run forever. Conservative — only flags definite cases.
        if (alwaysTrue(st.cond)) {
          errors.push(new LangError("Runtime", "This 'repeat while' can never stop — its condition is always true.", st.cond.line, st.cond.col, "Make the condition something that can become false (Sprout has no 'break')."));
        }
        checkStmts(st.body, vars, inTask);
        return;
      case "RepeatTimes":
        checkExpr(st.count, vars); checkStmts(st.body, vars, inTask);
        return;
      case "ForEach":
        checkExpr(st.iter, vars); checkStmts(st.body, vars, inTask);
        return;
      case "IndexSet":
        if (!vars.has(st.name)) {
          errors.push(new LangError("Name", `You're changing '${st.name}', but it was never created.`, st.line, st.col, varHint(st.name, vars) ?? `Create it first with: make ${st.name} = ...`));
        }
        checkExpr(st.index, vars); checkExpr(st.value, vars);
        return;
      case "Task":
        if (inTask) {
          errors.push(new LangError("Syntax", "Tasks must be defined at the top level, not inside another block.", st.line, st.col, "Move this 'task' out to the left margin."));
        }
        return;
      case "Give":
        if (!inTask) errors.push(new LangError("Runtime", "'give' only works inside a task.", st.line, st.col, "Move it inside a 'task ...:' block."));
        if (st.value) checkExpr(st.value, vars);
        return;
      case "Style":
        checkExpr(st.value, vars);
        return;
      case "Use":
        return;
      case "ExprStmt":
        checkExpr(st.expr, vars);
        return;
    }
  }

  function checkExpr(e: Expr, vars: Set<string>): void {
    switch (e.type) {
      case "Number": case "String": case "Bool": case "Nothing":
        return;
      case "Identifier":
        if (!vars.has(e.name)) {
          errors.push(new LangError("Name", `I don't know what '${e.name}' is.`, e.line, e.col, varHint(e.name, vars) ?? `Create it first with: make ${e.name} = ...`));
        }
        return;
      case "Unary":
        checkExpr(e.operand, vars); return;
      case "Binary":
      case "Logical":
        checkExpr(e.left, vars); checkExpr(e.right, vars); return;
      case "Call":
        e.args.forEach((a) => checkExpr(a, vars));
        checkCall(e); return;
      case "List":
        e.items.forEach((it) => checkExpr(it, vars)); return;
      case "Map":
        e.entries.forEach((en) => checkExpr(en.value, vars)); return;
      case "Index":
        checkExpr(e.target, vars); checkExpr(e.index, vars); return;
    }
  }

  function checkCall(e: Expr & { type: "Call" }): void {
    if (extra.has(e.name)) return; // a library builtin — its library handles name + arity
    let arity: [number, number] | undefined;
    if (taskArity.has(e.name)) arity = [taskArity.get(e.name)!, taskArity.get(e.name)!];
    else if (e.name in BUILTIN_ARITY) arity = BUILTIN_ARITY[e.name];
    else if (e.name in GUI_ARITY) arity = GUI_ARITY[e.name];
    else if (e.name in PERSIST_ARITY) arity = PERSIST_ARITY[e.name];
    else if (e.name in NET_ARITY) arity = NET_ARITY[e.name];
    else if (e.name in SECRET_ARITY) arity = SECRET_ARITY[e.name];
    else if (e.name in INPUT_ARITY) arity = INPUT_ARITY[e.name];
    else {
      errors.push(new LangError("Name", `I don't know a task called '${e.name}'.`, e.line, e.col, nearestHint(e.name, callable) ?? `Define it with: task ${e.name}(...):`));
      return;
    }
    const [min, max] = arity;
    if (e.args.length < min || e.args.length > max) {
      const need = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}-${max}`;
      const noun = max === 1 ? "value" : "values";
      errors.push(new LangError("Type", `'${e.name}' needs ${need} ${noun}, but you gave ${e.args.length}.`, e.line, e.col));
    }
  }

  function varHint(name: string, vars: Set<string>): string | undefined {
    return nearestHint(name, vars);
  }
  function nearestHint(name: string, names: Set<string>): string | undefined {
    const near = closest(name, [...names]);
    return near ? `Did you mean '${near}'?` : undefined;
  }
}

// A condition that is always true (so a `repeat while` using it can never stop).
// Deliberately narrow — only literal values — so it never flags a real loop.
function alwaysTrue(e: Expr): boolean {
  if (e.type === "Bool") return e.value === true;
  if (e.type === "Number") return e.value !== 0;
  if (e.type === "String") return e.value.length > 0;
  return false;
}

// All variable names created (via make) at one scope level — descending into
// when/while/repeat blocks (same scope) but NOT into nested task bodies.
function collectVars(stmts: Stmt[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: Stmt[]) => {
    for (const s of list) {
      if (s.type === "Make") out.add(s.name);
      else if (s.type === "When") {
        for (const b of s.branches) walk(b.body);
        if (s.otherwiseBody) walk(s.otherwiseBody);
      } else if (s.type === "RepeatWhile" || s.type === "RepeatTimes") {
        walk(s.body);
      } else if (s.type === "ForEach") {
        out.add(s.name); walk(s.body);
      } else if (s.type === "IndexSet") {
        // changes an existing variable; creates nothing
      }
    }
  };
  walk(stmts);
  return out;
}

function closest(name: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const cand of candidates) {
    const d = editDistance(name, cand);
    if (d < bestDist) { bestDist = d; best = cand; }
  }
  return bestDist <= 2 ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
