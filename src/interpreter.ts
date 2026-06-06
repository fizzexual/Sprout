// interpreter.ts — walks the syntax tree and actually runs the program.
//
// This is a "tree-walking" interpreter: the simplest kind. For each node we
// either evaluate it to a value (expressions) or perform its effect
// (statements). Values are plain JS numbers, strings, booleans, and `nothing`.

import { LangError } from "./errors.ts";
import type { Expr, Stmt } from "./ast.ts";
import type { Value } from "./values.ts";
import { isTruthy, NONE, stringify, typeName } from "./values.ts";
import { BUILTIN_NAMES, callBuiltin, isBuiltin } from "./builtins.ts";
import { callGuiBuiltin, GUI_BUILTINS, isGuiBuiltin, newGui } from "./gui.ts";
import type { GuiModel } from "./gui.ts";

// Where `show` sends its output. The CLI prints to the console; tests and the
// playground capture it instead.
export type OutputSink = (line: string) => void;

interface FuncDef {
  params: string[];
  body: Stmt[];
}

// A scope: a set of variables, with a link to the scope that contains it.
// Top-level code uses the global scope; each task call gets a fresh frame
// whose parent is the global scope.
class Environment {
  private vars = new Map<string, Value>();
  parent: Environment | undefined;

  constructor(parent?: Environment) {
    this.parent = parent;
  }

  define(name: string, value: Value): void {
    this.vars.set(name, value);
  }
  has(name: string): boolean {
    return this.vars.has(name) || (this.parent ? this.parent.has(name) : false);
  }
  get(name: string): Value {
    if (this.vars.has(name)) return this.vars.get(name) as Value;
    if (this.parent) return this.parent.get(name);
    return NONE;
  }
  // Update an existing variable wherever it lives. Returns false if not found.
  assign(name: string, value: Value): boolean {
    if (this.vars.has(name)) {
      this.vars.set(name, value);
      return true;
    }
    if (this.parent) return this.parent.assign(name, value);
    return false;
  }
  visibleNames(): string[] {
    const names = new Set<string>();
    let env: Environment | undefined = this;
    while (env) {
      for (const k of env.vars.keys()) names.add(k);
      env = env.parent;
    }
    return [...names];
  }
}

// Thrown to unwind out of a running task when `give` executes.
class ReturnSignal {
  value: Value;
  constructor(value: Value) {
    this.value = value;
  }
}

export class Interpreter {
  source: string;
  private out: OutputSink;
  private maxSteps: number;
  private steps = 0;
  private globals = new Environment();
  private functions = new Map<string, FuncDef>();
  private gui: GuiModel = newGui();

  constructor(
    source: string,
    out: OutputSink = (line) => console.log(line),
    options: { maxSteps?: number } = {},
  ) {
    this.source = source;
    this.out = out;
    this.maxSteps = options.maxSteps ?? Infinity;
  }

  run(program: Stmt[]): void {
    // Hoist top-level task definitions so they can be called from anywhere,
    // even before the line that defines them.
    for (const stmt of program) {
      if (stmt.type === "Task") this.functions.set(stmt.name, { params: stmt.params, body: stmt.body });
    }
    try {
      for (const stmt of program) this.execute(stmt, this.globals);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        throw new LangError("Runtime", "'give' only works inside a task.", 1, 1, "Move it inside a 'task ...:' block.");
      }
      throw e;
    }
  }

  // --- GUI support (used by gui-server.ts) ---------------------------------

  isGuiApp(): boolean {
    return this.gui.used;
  }

  getGui(): GuiModel {
    return this.gui;
  }

  setFieldValues(values: Record<string, string>): void {
    for (const w of this.gui.widgets) {
      if (w.kind === "field" && Object.prototype.hasOwnProperty.call(values, w.id)) {
        w.text = values[w.id];
      }
    }
  }

  // Run a button's task (which takes no inputs), keeping all program state
  // alive between clicks.
  clickButton(taskName: string): void {
    const fn = this.functions.get(taskName);
    if (!fn) {
      throw new LangError(
        "Name",
        `This button runs a task called '${taskName}', but there's no such task.`,
        1,
        1,
        `Define it with: task ${taskName}():`,
      );
    }
    if (fn.params.length !== 0) {
      throw new LangError(
        "Type",
        `A button's task ('${taskName}') shouldn't take any inputs.`,
        1,
        1,
        `Write it as: task ${taskName}():`,
      );
    }
    this.steps = 0;
    const frame = new Environment(this.globals);
    try {
      this.runBlock(fn.body, frame);
    } catch (e) {
      if (e instanceof ReturnSignal) return;
      if (e instanceof RangeError) {
        throw new LangError("Runtime", `The task '${taskName}' called itself too many times.`, 1, 1);
      }
      throw e;
    }
  }

  private execute(stmt: Stmt, env: Environment): void {
    if (++this.steps > this.maxSteps) {
      throw new LangError(
        "Runtime",
        "This program ran for too long — maybe an endless loop?",
        stmt.line,
        1,
        "Check that a 'repeat while' condition eventually becomes false.",
      );
    }

    switch (stmt.type) {
      case "Make": {
        env.define(stmt.name, this.evaluate(stmt.value, env));
        return;
      }
      case "Set": {
        const value = this.evaluate(stmt.value, env);
        if (!env.assign(stmt.name, value)) {
          throw new LangError(
            "Name",
            `You're trying to change '${stmt.name}', but it was never created.`,
            stmt.line,
            stmt.col,
            this.nameHint(stmt.name, env) ?? `Create it first with: make ${stmt.name} = ...`,
          );
        }
        return;
      }
      case "Show": {
        const parts = stmt.values.map((v) => stringify(this.evaluate(v, env)));
        this.out(parts.join(" "));
        return;
      }
      case "When": {
        for (const branch of stmt.branches) {
          if (isTruthy(this.evaluate(branch.cond, env))) {
            this.runBlock(branch.body, env);
            return;
          }
        }
        if (stmt.otherwiseBody) this.runBlock(stmt.otherwiseBody, env);
        return;
      }
      case "RepeatWhile": {
        while (isTruthy(this.evaluate(stmt.cond, env))) this.runBlock(stmt.body, env);
        return;
      }
      case "RepeatTimes": {
        const n = this.evaluate(stmt.count, env);
        if (typeof n !== "number") {
          throw new LangError(
            "Type",
            `'repeat ... times' needs a number, but got ${typeName(n)}.`,
            stmt.line,
            1,
            "Like: repeat 3 times:",
          );
        }
        const count = Math.floor(n);
        for (let k = 0; k < count; k++) this.runBlock(stmt.body, env);
        return;
      }
      case "Task": {
        if (env !== this.globals) {
          throw new LangError(
            "Syntax",
            "For now, tasks must be defined at the top level, not inside another block.",
            stmt.line,
            stmt.col,
            "Move this 'task' out to the left margin.",
          );
        }
        this.functions.set(stmt.name, { params: stmt.params, body: stmt.body });
        return;
      }
      case "Give": {
        throw new ReturnSignal(stmt.value ? this.evaluate(stmt.value, env) : NONE);
      }
      case "ExprStmt": {
        this.evaluate(stmt.expr, env);
        return;
      }
    }
  }

  private runBlock(stmts: Stmt[], env: Environment): void {
    for (const stmt of stmts) this.execute(stmt, env);
  }

  private evaluate(expr: Expr, env: Environment): Value {
    switch (expr.type) {
      case "Number": return expr.value;
      case "String": return expr.value;
      case "Bool": return expr.value;
      case "Identifier": {
        if (!env.has(expr.name)) {
          throw new LangError(
            "Name",
            `I don't know what '${expr.name}' is.`,
            expr.line,
            expr.col,
            this.nameHint(expr.name, env) ?? `Create it first with: make ${expr.name} = ...`,
          );
        }
        return env.get(expr.name);
      }
      case "Unary": {
        if (expr.op === "-") {
          const v = this.evaluate(expr.operand, env);
          if (typeof v !== "number") {
            throw new LangError(
              "Type",
              `I can only put a minus sign in front of a number, not ${typeName(v)}.`,
              expr.line,
              expr.col,
            );
          }
          return -v;
        }
        return !isTruthy(this.evaluate(expr.operand, env));
      }
      case "Logical": {
        const left = this.evaluate(expr.left, env);
        if (expr.op === "and") {
          if (!isTruthy(left)) return false;
          return isTruthy(this.evaluate(expr.right, env));
        }
        if (isTruthy(left)) return true;
        return isTruthy(this.evaluate(expr.right, env));
      }
      case "Binary": return this.binary(expr, env);
      case "Call": return this.call(expr, env);
    }
  }

  private call(expr: Expr & { type: "Call" }, env: Environment): Value {
    const args = expr.args.map((a) => this.evaluate(a, env));

    const fn = this.functions.get(expr.name);
    if (fn) return this.callTask(expr.name, fn, args, expr);

    if (isGuiBuiltin(expr.name)) return callGuiBuiltin(this.gui, expr.name, args, { line: expr.line, col: expr.col });
    if (isBuiltin(expr.name)) return callBuiltin(expr.name, args, { line: expr.line, col: expr.col });

    const near = closest(expr.name, [...this.functions.keys(), ...GUI_BUILTINS, ...BUILTIN_NAMES]);
    throw new LangError(
      "Name",
      `I don't know a task called '${expr.name}'.`,
      expr.line,
      expr.col,
      near ? `Did you mean '${near}'?` : `Define it with: task ${expr.name}(...):`,
    );
  }

  private callTask(name: string, fn: FuncDef, args: Value[], site: Expr): Value {
    if (args.length !== fn.params.length) {
      const need = fn.params.length;
      throw new LangError(
        "Type",
        `The task '${name}' needs ${need} ${need === 1 ? "value" : "values"} (${fn.params.join(", ") || "none"}), but you gave ${args.length}.`,
        site.line,
        site.col,
        `Like: ${name}(${fn.params.join(", ")})`,
      );
    }

    const frame = new Environment(this.globals);
    for (let i = 0; i < fn.params.length; i++) frame.define(fn.params[i], args[i]);

    try {
      this.runBlock(fn.body, frame);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      if (e instanceof RangeError) {
        throw new LangError(
          "Runtime",
          `The task '${name}' called itself too many times (no stopping point?).`,
          site.line,
          site.col,
          "A task that calls itself needs a 'when' that eventually stops.",
        );
      }
      throw e;
    }
    return NONE; // the task finished without giving anything back
  }

  private binary(expr: Expr & { type: "Binary" }, env: Environment): Value {
    const l = this.evaluate(expr.left, env);
    const r = this.evaluate(expr.right, env);
    const op = expr.op;

    if (op === "+") {
      // If either side is text, join them as text (friendly for messages).
      if (typeof l === "string" || typeof r === "string") return stringify(l) + stringify(r);
      if (typeof l === "number" && typeof r === "number") return l + r;
      throw this.mathErr("add", l, r, expr);
    }

    if (op === "-" || op === "*" || op === "/" || op === "%") {
      if (typeof l !== "number" || typeof r !== "number") {
        throw this.mathErr(opWord(op), l, r, expr);
      }
      if (op === "-") return l - r;
      if (op === "*") return l * r;
      if (op === "/") {
        if (r === 0) {
          throw new LangError("Runtime", "You tried to divide by zero, which has no answer.", expr.line, expr.col);
        }
        return l / r;
      }
      // op === "%"
      if (r === 0) {
        throw new LangError("Runtime", "You tried to take a remainder with zero.", expr.line, expr.col);
      }
      return l % r;
    }

    if (op === "<" || op === "<=" || op === ">" || op === ">=") {
      if (typeof l === "number" && typeof r === "number") return compare(op, l, r);
      if (typeof l === "string" && typeof r === "string") return compare(op, l, r);
      throw new LangError(
        "Type",
        `I can't compare ${typeName(l)} with ${typeName(r)} using '${op}'.`,
        expr.line,
        expr.col,
        "Compare two numbers, or two pieces of text.",
      );
    }

    if (op === "==") return equalValues(l, r);
    if (op === "!=") return !equalValues(l, r);

    throw new LangError("Runtime", `I ran into an unknown operator '${op}'.`, expr.line, expr.col);
  }

  private mathErr(word: string, l: Value, r: Value, expr: Expr): LangError {
    return new LangError(
      "Type",
      `I can't ${word} ${typeName(l)} and ${typeName(r)}.`,
      expr.line,
      expr.col,
      "Math like this works on numbers.",
    );
  }

  private nameHint(name: string, env: Environment): string | undefined {
    const near = closest(name, env.visibleNames());
    return near ? `Did you mean '${near}'?` : undefined;
  }
}

// --- small helpers ---------------------------------------------------------

function opWord(op: string): string {
  if (op === "-") return "subtract";
  if (op === "*") return "multiply";
  if (op === "/") return "divide";
  return "take the remainder of";
}

function compare(op: string, l: number | string, r: number | string): boolean {
  if (op === "<") return l < r;
  if (op === "<=") return l <= r;
  if (op === ">") return l > r;
  return l >= r;
}

function equalValues(l: Value, r: Value): boolean {
  return typeof l === typeof r && l === r;
}

// Suggest the closest known name (for friendly "did you mean?" hints).
function closest(name: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const cand of candidates) {
    const d = editDistance(name, cand);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  return bestDist <= 2 ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[n];
}
