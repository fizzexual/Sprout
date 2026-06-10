// errors.ts — Sprout's friendly error type and pretty-printer.
//
// The whole personality of Sprout lives here: when something goes wrong we
// show the exact line, point at the spot with a caret, and explain it in
// plain language a beginner can understand.

export type ErrorKind = "Syntax" | "Name" | "Type" | "Runtime" | "Indentation";

export class LangError extends Error {
  kind: ErrorKind;
  line: number;
  col: number;
  hint: string | undefined;

  constructor(kind: ErrorKind, message: string, line: number, col: number, hint?: string) {
    super(message);
    this.name = "LangError";
    this.kind = kind;
    this.line = line;
    this.col = col;
    this.hint = hint;
  }
}

// Render a LangError against the original source as a friendly, pointed message.
export function formatError(err: LangError, source: string): string {
  const lines = source.split(/\r?\n/);
  const lineText = lines[err.line - 1] ?? "";
  const lineNoStr = String(err.line);
  const gutter = " ".repeat(lineNoStr.length);
  const caretPad = " ".repeat(Math.max(0, err.col - 1));

  const out: string[] = [];
  out.push(`🌱 Oops — ${err.kind.toLowerCase()} problem on line ${err.line}:`);
  out.push("");
  out.push(`  ${lineNoStr} | ${lineText}`);
  out.push(`  ${gutter} | ${caretPad}^`);
  out.push("");
  out.push(`  ${err.message}`);
  if (err.hint) {
    out.push("");
    out.push(`  💡 ${err.hint}`);
  }
  return out.join("\n");
}

// Render a friendly message that isn't tied to a source location — used to turn
// raw Node/system errors into Sprout's voice instead of a stack trace.
export function formatMessage(message: string, hint?: string): string {
  const out = [`🌱 Oops — ${message}`];
  if (hint) {
    out.push("");
    out.push(`  💡 ${hint}`);
  }
  return out.join("\n");
}
