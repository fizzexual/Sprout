// interpreter.ts — walks the syntax tree and actually runs the program.
//
// This is a "tree-walking" interpreter: the simplest kind. For each node we
// either evaluate it to a value (expressions) or perform its effect
// (statements). Values are plain JS numbers, strings, booleans, and `nothing`.

import { LangError } from "./errors.ts";
import type { Expr, Stmt } from "./ast.ts";
import type { Value } from "./values.ts";
import { isTruthy, NONE, stringify, typeName, SList, SMap, equalValues } from "./values.ts";
import { BUILTIN_NAMES, callBuiltin, isBuiltin } from "./builtins.ts";
import { callGuiBuiltin, GUI_BUILTINS, isGuiBuiltin, newGui } from "./gui.ts";
import type { GuiModel } from "./gui.ts";
import { memoryStorage, PERSIST_BUILTINS } from "./storage.ts";
import type { Storage } from "./storage.ts";
import { NET_BUILTINS, noNet } from "./net.ts";
import type { Net } from "./net.ts";
import { SECRET_BUILTINS, noSecrets, missingSecret } from "./secrets.ts";
import type { Secrets } from "./secrets.ts";
import { INPUT_BUILTINS, noInput } from "./input.ts";
import type { Input } from "./input.ts";

// Where `show` sends its output. The CLI prints to the console; tests capture it.
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
  // One walk up the scope chain. Returns undefined ONLY when the name is unset
  // (a real Value is never undefined), so get/has share this single lookup.
  lookup(name: string): Value | undefined {
    const v = this.vars.get(name);
    if (v !== undefined) return v;
    return this.parent ? this.parent.lookup(name) : undefined;
  }
  has(name: string): boolean {
    return this.lookup(name) !== undefined;
  }
  get(name: string): Value {
    const v = this.lookup(name);
    return v === undefined ? NONE : v;
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

// A resolved call target, cached on a Call AST node (the inline call cache).
type CallHandler = (args: Value[], expr: Expr & { type: "Call" }) => Value;
interface CachedCall { __h?: CallHandler }

export class Interpreter {
  source: string;
  programDir: string;            // folder of the running program; libraries/extensions read & write their files next to it
  programFile: string;           // absolute path of the entry .sprout file ("" if unknown); used by libraries like automations
  private out: OutputSink;
  private maxSteps: number;
  private steps = 0;
  private globals = new Environment();
  private functions = new Map<string, FuncDef>();
  private libBuiltins = new Map<string, (args: Value[], site: { line: number; col: number }) => Value>();
  private gui: GuiModel = newGui();
  private store: Storage;
  private data: Record<string, Value>;
  private net: Net;
  private secrets: Secrets;
  private input: Input;
  // Plain-English narration for `sprout explain`. null = off (normal run).
  private narrate: ((msg: string) => void) | null;
  // Step hook for `sprout trace`: called before each statement runs, with its
  // line and a snapshot of the variables in scope. null = off (normal run).
  private onStep: ((line: number, vars: [string, string][]) => void) | null;
  // True during `sprout trace`. Libraries read it to skip things that don't make
  // sense while stepping — e.g. wait() shouldn't freeze the trace for real.
  public tracing = false;
  private depth = 0;
  // `give` returns via these flags instead of throwing an exception (much faster
  // for recursion-heavy code). runBlock + the loops stop when `returning` is set.
  private returning = false;
  private returnValue: Value = NONE;

  constructor(
    source: string,
    out: OutputSink = (line) => console.log(line),
    options: { maxSteps?: number; storage?: Storage; net?: Net; secrets?: Secrets; programDir?: string; programFile?: string; input?: Input; narrate?: (msg: string) => void; onStep?: (line: number, vars: [string, string][]) => void } = {},
  ) {
    this.source = source;
    this.out = out;
    this.maxSteps = options.maxSteps ?? Infinity;
    this.store = options.storage ?? memoryStorage();
    this.data = this.store.load();
    this.net = options.net ?? noNet();
    this.secrets = options.secrets ?? noSecrets();
    this.programDir = options.programDir ?? process.cwd();
    this.programFile = options.programFile ?? "";
    this.input = options.input ?? noInput();
    this.narrate = options.narrate ?? null;
    this.onStep = options.onStep ?? null;
    this.tracing = this.onStep !== null;
  }

  // Emit one indented line of plain-English narration (only in explain mode).
  // Takes a thunk so we never pay the formatting cost on a normal run.
  private say(make: () => string): void {
    if (this.narrate) this.narrate("  ".repeat(this.depth) + make());
  }

  run(program: Stmt[]): void {
    // Hoist top-level task definitions so they can be called from anywhere,
    // even before the line that defines them.
    for (const stmt of program) {
      if (stmt.type === "Task") this.functions.set(stmt.name, { params: stmt.params, body: stmt.body });
    }
    for (const stmt of program) {
      this.execute(stmt, this.globals);
      if (this.returning) {
        this.returning = false;
        throw new LangError("Runtime", "'give' only works inside a task.", 1, 1, "Move it inside a 'task ...:' block.");
      }
    }
  }

  // --- GUI support (used by gui-server.ts) ---------------------------------

  // --- Library support (used by the CLI's library loader) ---

  registerLibraryBuiltins(map: Record<string, (args: Value[], site: { line: number; col: number }) => Value>): void {
    for (const [name, fn] of Object.entries(map)) this.libBuiltins.set(name, fn);
  }

  // Run a top-level task by name (no inputs) — used by libraries to dispatch
  // events (e.g. a Discord message) to the program's handler task.
  runTask(name: string): void {
    const fn = this.functions.get(name);
    if (!fn) {
      throw new LangError("Name", `There's no task called '${name}'.`, 1, 1, `Define it with: task ${name}():`);
    }
    this.steps = 0;
    const frame = new Environment(this.globals);
    try {
      this.runBlock(fn.body, frame);
    } catch (e) {
      if (e instanceof RangeError) { this.returning = false; throw new LangError("Runtime", `The task '${name}' went too deep.`, 1, 1); }
      this.returning = false;
      throw e;
    }
    this.returning = false;   // a `give` in an event task just ends it
  }

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
    // SECURITY: only tasks actually wired to a button may be triggered. This
    // keeps "backend" tasks (helpers, data access, anything not on a button)
    // unreachable from the browser — a client can't invoke arbitrary code.
    const wired = this.gui.widgets.some((w) => w.kind === "button" && w.onClick === taskName);
    if (!wired) {
      throw new LangError("Name", "That action isn't available.", 1, 1, "Only a button's own task can run.");
    }

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
      this.returning = false;
      if (e instanceof RangeError) {
        throw new LangError("Runtime", `The task '${taskName}' called itself too many times.`, 1, 1);
      }
      throw e;
    }
    this.returning = false;   // a `give` in a button task just ends it
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

    // `sprout trace`: pause before each statement with the line + variables.
    if (this.onStep) this.onStep(stmt.line, env.visibleNames().map((n) => [n, stringify(env.get(n))] as [string, string]));

    switch (stmt.type) {
      case "Make": {
        const made = this.evaluate(stmt.value, env);
        env.define(stmt.name, made);
        if (this.narrate) this.say(() => `make ${stmt.name} = ${exprText(stmt.value)}  →  ${stmt.name} is ${stringify(made)}`);
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
        if (this.narrate) this.say(() => `set ${stmt.name} = ${exprText(stmt.value)}  →  ${stmt.name} is now ${stringify(value)}`);
        return;
      }
      case "Show": {
        const parts = stmt.values.map((v) => stringify(this.evaluate(v, env)));
        this.out(parts.join(" "));
        return;
      }
      case "When": {
        for (const branch of stmt.branches) {
          const cv = this.evaluate(branch.cond, env);
          if (this.narrate) this.say(() => `is ${exprText(branch.cond)}? → ${stringify(cv)}`);
          if (isTruthy(cv)) {
            if (this.narrate) this.say(() => "yes — so I run this part:");
            this.depth++; this.runBlock(branch.body, env); this.depth--;
            return;
          }
        }
        if (stmt.otherwiseBody) {
          if (this.narrate) this.say(() => "none were true — so I run the 'otherwise' part:");
          this.depth++; this.runBlock(stmt.otherwiseBody, env); this.depth--;
        }
        return;
      }
      case "RepeatWhile": {
        if (this.narrate) this.say(() => `repeat while ${exprText(stmt.cond)}:`);
        for (;;) {
          const cv = this.evaluate(stmt.cond, env);
          if (this.narrate) this.say(() => `  ${exprText(stmt.cond)} is ${stringify(cv)}${isTruthy(cv) ? " — keep going" : " — stop"}`);
          if (!isTruthy(cv)) break;
          this.depth++; this.runBlock(stmt.body, env); this.depth--;
          if (this.returning) return;
        }
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
        if (this.narrate) this.say(() => `repeat ${count} time${count === 1 ? "" : "s"}:`);
        for (let k = 0; k < count; k++) { if (this.narrate) this.say(() => `round ${k + 1} of ${count}:`); this.depth++; this.runBlock(stmt.body, env); this.depth--; if (this.returning) return; }
        return;
      }
      case "ForEach": {
        const coll = this.evaluate(stmt.iter, env);
        let items: Value[];
        if (coll instanceof SList) items = coll.items;
        else if (coll instanceof SMap) items = [...coll.entries.keys()];
        else if (typeof coll === "string") items = [...coll];
        else {
          throw new LangError(
            "Type",
            `'for each' needs a list, a map, or text to go through, but got ${typeName(coll)}.`,
            stmt.line, stmt.col,
            "Like: for each item in [1, 2, 3]:",
          );
        }
        // Snapshot the items so changes during the loop don't affect iteration.
        if (this.narrate) this.say(() => `for each ${stmt.name} in ${exprText(stmt.iter)}:`);
        const snapshot = items.slice();   // changes during the loop don't affect iteration
        for (const item of snapshot) {
          env.define(stmt.name, item);
          if (this.narrate) this.say(() => `${stmt.name} = ${stringify(item)}:`);
          this.depth++; this.runBlock(stmt.body, env); this.depth--;
          if (this.returning) return;
        }
        return;
      }
      case "IndexSet": {
        if (!env.has(stmt.name)) {
          throw new LangError("Name", `You're changing '${stmt.name}', but it was never created.`, stmt.line, stmt.col, this.nameHint(stmt.name, env) ?? `Create it first with: make ${stmt.name} = ...`);
        }
        const coll = env.get(stmt.name);
        const index = this.evaluate(stmt.index, env);
        const value = this.evaluate(stmt.value, env);
        if (coll instanceof SList) {
          if (typeof index !== "number") throw new LangError("Type", `A list is numbered, so its index must be a number, not ${typeName(index)}.`, stmt.line, stmt.col, `Like: set ${stmt.name}[0] = ...`);
          const i = Math.floor(index);
          if (i < 0 || i > coll.items.length) throw new LangError("Runtime", `That spot (${i}) is outside the list (it has ${coll.items.length} item${coll.items.length === 1 ? "" : "s"}).`, stmt.line, stmt.col, "Use add(list, item) to grow it.");
          coll.items[i] = value; // i === length appends
        } else if (coll instanceof SMap) {
          coll.entries.set(stringify(index), value);
        } else {
          throw new LangError("Type", `I can only set an item inside a list or a map, but '${stmt.name}' is ${typeName(coll)}.`, stmt.line, stmt.col);
        }
        if (this.narrate) this.say(() => `set ${stmt.name}[${exprText(stmt.index)}] = ${exprText(stmt.value)}  →  ${stmt.name} is now ${stringify(coll)}`);
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
        const gv = stmt.value ? this.evaluate(stmt.value, env) : NONE;
        if (this.narrate) this.say(() => `give back ${stringify(gv)}`);
        this.returnValue = gv;
        this.returning = true;
        return;
      }
      case "Style": {
        const v = this.evaluate(stmt.value, env);
        if (typeof v === "string") this.gui.stylePath = v;
        return;
      }
      case "Use": {
        // Libraries are loaded by the CLI before running; nothing to do here.
        return;
      }
      case "ExprStmt": {
        this.evaluate(stmt.expr, env);
        return;
      }
    }
  }

  private runBlock(stmts: Stmt[], env: Environment): void {
    for (const stmt of stmts) {
      this.execute(stmt, env);
      if (this.returning) return;   // a `give` ran — stop this block and unwind
    }
  }

  private evaluate(expr: Expr, env: Environment): Value {
    switch (expr.type) {
      case "Number": return expr.value;
      case "String": return expr.value;
      case "Bool": return expr.value;
      case "Nothing": return NONE;
      case "Identifier": {
        const v = env.lookup(expr.name);
        if (v === undefined) {
          throw new LangError(
            "Name",
            `I don't know what '${expr.name}' is.`,
            expr.line,
            expr.col,
            this.nameHint(expr.name, env) ?? `Create it first with: make ${expr.name} = ...`,
          );
        }
        return v;
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
      case "List": return new SList(expr.items.map((it) => this.evaluate(it, env)));
      case "Map": {
        const m = new Map<string, Value>();
        for (const e of expr.entries) m.set(e.key, this.evaluate(e.value, env));
        return new SMap(m);
      }
      case "Index": {
        const target = this.evaluate(expr.target, env);
        const index = this.evaluate(expr.index, env);
        if (target instanceof SList) {
          if (typeof index !== "number") throw new LangError("Type", `A list is numbered, so the index in [...] must be a number, not ${typeName(index)}.`, expr.line, expr.col, "Like: things[0]");
          const i = Math.floor(index);
          return i >= 0 && i < target.items.length ? target.items[i] : NONE;
        }
        if (target instanceof SMap) return target.entries.has(stringify(index)) ? target.entries.get(stringify(index)) as Value : NONE;
        if (typeof target === "string") {
          if (typeof index !== "number") throw new LangError("Type", `Text is numbered, so the index in [...] must be a number, not ${typeName(index)}.`, expr.line, expr.col, 'Like: word[0]');
          const i = Math.floor(index);
          return i >= 0 && i < target.length ? target[i] : NONE;
        }
        throw new LangError("Type", `I can only look inside a list, a map, or text with [...], not ${typeName(target)}.`, expr.line, expr.col);
      }
    }
  }

  private call(expr: Expr & { type: "Call" }, env: Environment): Value {
    const args = expr.args.map((a) => this.evaluate(a, env));
    // Inline cache: the name->handler decision is stable for the whole run
    // (tasks/library builtins are registered before run), so resolve it once per
    // call-site and reuse it — skips the whole dispatch chain on every later call.
    const cached = (expr as CachedCall).__h;
    if (cached) return cached(args, expr);
    return this.resolveCall(expr, args);
  }

  private resolveCall(expr: Expr & { type: "Call" }, args: Value[]): Value {
    const name = expr.name;
    let h: CallHandler;
    if (this.functions.has(name)) h = (a, e) => this.callTask(e.name, this.functions.get(e.name)!, a, e);
    else if (isGuiBuiltin(name)) h = (a, e) => callGuiBuiltin(this.gui, e.name, a, { line: e.line, col: e.col });
    else if (PERSIST_BUILTINS.includes(name)) h = (a, e) => this.persist(e.name, a, e);
    else if (NET_BUILTINS.includes(name)) h = (a, e) => this.netCall(e.name, a, e);
    else if (SECRET_BUILTINS.includes(name)) h = (a, e) => this.secretCall(a, e);
    else if (INPUT_BUILTINS.includes(name)) h = (a) => this.input.ask(a.length > 0 ? stringify(a[0]) : "");
    else if (this.libBuiltins.has(name)) h = (a, e) => this.libBuiltins.get(e.name)!(a, { line: e.line, col: e.col });
    else if (isBuiltin(name)) h = (a, e) => callBuiltin(e.name, a, { line: e.line, col: e.col });
    else return this.unknownCall(expr);
    (expr as CachedCall).__h = h;
    return h(args, expr);
  }

  private unknownCall(expr: Expr & { type: "Call" }): never {
    const near = closest(expr.name, [...this.functions.keys(), ...this.libBuiltins.keys(), ...GUI_BUILTINS, ...PERSIST_BUILTINS, ...NET_BUILTINS, ...SECRET_BUILTINS, ...INPUT_BUILTINS, ...BUILTIN_NAMES]);
    throw new LangError(
      "Name",
      `I don't know a task called '${expr.name}'.`,
      expr.line,
      expr.col,
      near ? `Did you mean '${near}'?` : `Define it with: task ${expr.name}(...):`,
    );
  }

  // get("url")  /  post("url", body)
  private netCall(name: string, args: Value[], site: Expr): Value {
    const url = args[0];
    if (typeof url !== "string") {
      throw new LangError("Type", `'${name}' needs a web address in quotes.`, site.line, site.col, `Like: ${name}("https://example.com")`);
    }
    try {
      if (name === "get") return this.net.get(url);
      return this.net.post(url, args.length > 1 ? stringify(args[1]) : "");
    } catch (e) {
      if (e instanceof LangError) throw e;
      throw new LangError("Runtime", `I couldn't reach ${url}.`, site.line, site.col, e instanceof Error ? e.message : undefined);
    }
  }

  // secret("NAME") — read a token from the environment or a .env file, so it's
  // never written into the program itself.
  private secretCall(args: Value[], site: Expr): Value {
    const name = args[0];
    if (typeof name !== "string") {
      throw new LangError("Type", "'secret' needs the secret's name in quotes.", site.line, site.col, 'Like: secret("DISCORD_TOKEN")');
    }
    const value = this.secrets.get(name);
    if (value === null) throw missingSecret(name, site.line, site.col);
    return value;
  }

  // remember("key", value)  /  recall("key", default?)
  private persist(name: string, args: Value[], site: Expr): Value {
    const key = args[0];
    if (typeof key !== "string") {
      throw new LangError(
        "Type",
        `'${name}' needs a name in quotes for its first value.`,
        site.line,
        site.col,
        name === "remember" ? 'Like: remember "score", 10' : 'Like: recall "score"',
      );
    }
    if (name === "remember") {
      const value = args[1];
      if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") this.data[key] = value;
      else delete this.data[key];
      this.store.save(this.data);
      return value ?? NONE;
    }
    // recall
    if (key in this.data) return this.data[key];
    return args.length > 1 ? args[1] : NONE;
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
    if (this.returning) { this.returning = false; return this.returnValue; }
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
      // Two lists join into a longer list: [1, 2] + [3] -> [1, 2, 3].
      if (l instanceof SList && r instanceof SList) return new SList([...l.items, ...r.items]);
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

// Render an expression back to readable Sprout-ish text (used by `sprout explain`).
function exprText(e: Expr): string {
  switch (e.type) {
    case "Number": return String(e.value);
    case "String": return '"' + e.value + '"';
    case "Bool": return e.value ? "yes" : "no";
    case "Nothing": return "nothing";
    case "Identifier": return e.name;
    case "Unary": return (e.op === "-" ? "-" : "not ") + exprText(e.operand);
    case "Binary": return exprText(e.left) + " " + e.op + " " + exprText(e.right);
    case "Logical": return exprText(e.left) + " " + e.op + " " + exprText(e.right);
    case "Call": return e.name + "(" + e.args.map(exprText).join(", ") + ")";
    case "List": return "[" + e.items.map(exprText).join(", ") + "]";
    case "Map": return "{" + e.entries.map((en) => en.key + ": " + exprText(en.value)).join(", ") + "}";
    case "Index": return exprText(e.target) + "[" + exprText(e.index) + "]";
  }
}

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
