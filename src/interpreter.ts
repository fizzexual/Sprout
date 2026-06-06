// interpreter.ts — walks the syntax tree and actually runs the program.
//
// This is a "tree-walking" interpreter: the simplest kind. For each node we
// either evaluate it to a value (expressions) or perform its effect
// (statements). Values are plain JS numbers, strings, and booleans.

import { LangError } from "./errors.ts";
import type { Expr, Stmt } from "./ast.ts";
import type { Value } from "./values.ts";
import { isTruthy, stringify, typeName } from "./values.ts";
import { BUILTIN_NAMES, callBuiltin, isBuiltin } from "./builtins.ts";

// Where `say` sends its output. The CLI prints to the console; tests and the
// (future) browser playground capture it instead.
export type OutputSink = (line: string) => void;

// For now Sprout has a single global scope. (Functions, which will add their
// own scopes, come in a later slice.) This matches Python's beginner-friendly
// rule that variables made inside an if/while are still visible afterwards.
class Environment {
  private vars = new Map<string, Value>();

  define(name: string, value: Value): void {
    this.vars.set(name, value);
  }
  has(name: string): boolean {
    return this.vars.has(name);
  }
  get(name: string): Value {
    return this.vars.get(name) as Value;
  }
  names(): string[] {
    return [...this.vars.keys()];
  }
}

export class Interpreter {
  source: string;
  private env = new Environment();
  private out: OutputSink;

  constructor(source: string, out: OutputSink = (line) => console.log(line)) {
    this.source = source;
    this.out = out;
  }

  run(program: Stmt[]): void {
    for (const stmt of program) this.execute(stmt);
  }

  private execute(stmt: Stmt): void {
    switch (stmt.type) {
      case "Make": {
        this.env.define(stmt.name, this.evaluate(stmt.value));
        return;
      }
      case "Set": {
        if (!this.env.has(stmt.name)) {
          throw new LangError(
            "Name",
            `You're trying to change '${stmt.name}', but it was never created.`,
            stmt.line,
            stmt.col,
            this.nameHint(stmt.name) ?? `Create it first with: make ${stmt.name} = ...`,
          );
        }
        this.env.define(stmt.name, this.evaluate(stmt.value));
        return;
      }
      case "Show": {
        const parts = stmt.values.map((v) => stringify(this.evaluate(v)));
        this.out(parts.join(" "));
        return;
      }
      case "When": {
        for (const branch of stmt.branches) {
          if (isTruthy(this.evaluate(branch.cond))) {
            this.runBlock(branch.body);
            return;
          }
        }
        if (stmt.otherwiseBody) this.runBlock(stmt.otherwiseBody);
        return;
      }
      case "RepeatWhile": {
        while (isTruthy(this.evaluate(stmt.cond))) this.runBlock(stmt.body);
        return;
      }
      case "RepeatTimes": {
        const n = this.evaluate(stmt.count);
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
        for (let k = 0; k < count; k++) this.runBlock(stmt.body);
        return;
      }
      case "ExprStmt": {
        this.evaluate(stmt.expr);
        return;
      }
    }
  }

  private runBlock(stmts: Stmt[]): void {
    for (const stmt of stmts) this.execute(stmt);
  }

  private evaluate(expr: Expr): Value {
    switch (expr.type) {
      case "Number": return expr.value;
      case "String": return expr.value;
      case "Bool": return expr.value;
      case "Identifier": {
        if (!this.env.has(expr.name)) {
          throw new LangError(
            "Name",
            `I don't know what '${expr.name}' is.`,
            expr.line,
            expr.col,
            this.nameHint(expr.name) ?? `Create it first with: let ${expr.name} = ...`,
          );
        }
        return this.env.get(expr.name);
      }
      case "Unary": {
        if (expr.op === "-") {
          const v = this.evaluate(expr.operand);
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
        return !isTruthy(this.evaluate(expr.operand));
      }
      case "Logical": {
        const left = this.evaluate(expr.left);
        if (expr.op === "and") {
          if (!isTruthy(left)) return false;
          return isTruthy(this.evaluate(expr.right));
        }
        if (isTruthy(left)) return true;
        return isTruthy(this.evaluate(expr.right));
      }
      case "Binary": return this.binary(expr);
      case "Call": {
        const args = expr.args.map((a) => this.evaluate(a));
        if (!isBuiltin(expr.name)) {
          const near = closest(expr.name, BUILTIN_NAMES);
          throw new LangError(
            "Name",
            `I don't know a function called '${expr.name}'.`,
            expr.line,
            expr.col,
            near ? `Did you mean '${near}'?` : "Built-in functions include: sqrt, round, max, min, length, upper, lower.",
          );
        }
        return callBuiltin(expr.name, args, { line: expr.line, col: expr.col });
      }
    }
  }

  private binary(expr: Expr & { type: "Binary" }): Value {
    const l = this.evaluate(expr.left);
    const r = this.evaluate(expr.right);
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

  private nameHint(name: string): string | undefined {
    const near = closest(name, this.env.names());
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
