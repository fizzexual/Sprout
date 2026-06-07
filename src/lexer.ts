// lexer.ts — turns raw Sprout source text into a list of tokens.
//
// Sprout uses indentation for blocks (like Python), so the lexer also emits
// INDENT / DEDENT tokens by tracking how deep each line is indented.

import { LangError } from "./errors.ts";
import type { Token, TokenType } from "./token.ts";

const KEYWORDS: Record<string, TokenType> = {
  make: "MAKE",
  set: "SET",
  show: "SHOW",
  when: "WHEN",
  orwhen: "ORWHEN",
  otherwise: "OTHERWISE",
  repeat: "REPEAT",
  while: "WHILE",
  times: "TIMES",
  and: "AND",
  or: "OR",
  not: "NOT",
  yes: "YES",
  no: "NO",
  nothing: "NOTHING",
  task: "TASK",
  give: "GIVE",
  style: "STYLE",
  use: "USE",
};

const SINGLE: Record<string, TokenType> = {
  "+": "PLUS",
  "-": "MINUS",
  "*": "STAR",
  "/": "SLASH",
  "%": "PERCENT",
  "=": "EQ",
  "<": "LT",
  ">": "GT",
  "(": "LPAREN",
  ")": "RPAREN",
  ",": "COMMA",
  ":": "COLON",
};

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const indentStack: number[] = [0];
  const rawLines = source.split(/\r?\n/);

  const push = (type: TokenType, value: string, line: number, col: number) => {
    tokens.push({ type, value, line, col });
  };

  for (let li = 0; li < rawLines.length; li++) {
    const line = rawLines[li];
    const lineNo = li + 1;

    // Measure leading indentation (spaces only).
    let i = 0;
    while (i < line.length && line[i] === " ") i++;
    if (i < line.length && line[i] === "\t") {
      throw new LangError(
        "Indentation",
        "I found a tab used for spacing at the start of this line.",
        lineNo,
        i + 1,
        "Please indent with spaces instead of tabs — it keeps lines lined up.",
      );
    }

    const rest = line.slice(i);

    // Blank lines and comment-only lines are ignored completely: they don't
    // start a NEWLINE and don't change the indentation level.
    if (rest.length === 0 || rest[0] === "~") continue;

    // Compare this line's indentation against the stack.
    const indent = i;
    const top = indentStack[indentStack.length - 1];
    if (indent > top) {
      indentStack.push(indent);
      push("INDENT", "", lineNo, 1);
    } else if (indent < top) {
      while (indentStack.length > 1 && indentStack[indentStack.length - 1] > indent) {
        indentStack.pop();
        push("DEDENT", "", lineNo, 1);
      }
      if (indentStack[indentStack.length - 1] !== indent) {
        throw new LangError(
          "Indentation",
          "This line's indentation doesn't line up with any block above it.",
          lineNo,
          indent + 1,
          "Each step inside a block is usually 4 spaces deeper than its header.",
        );
      }
    }

    // Scan the actual content of the line.
    let j = 0;
    const colOf = (k: number) => i + k + 1;

    while (j < rest.length) {
      const c = rest[j];

      if (c === " " || c === "\t") {
        j++;
        continue;
      }

      if (c === "~") break; // trailing comment

      // Numbers: 123 or 3.14
      if (isDigit(c)) {
        const start = j;
        while (j < rest.length && isDigit(rest[j])) j++;
        if (rest[j] === "." && isDigit(rest[j + 1])) {
          j++;
          while (j < rest.length && isDigit(rest[j])) j++;
        }
        push("NUMBER", rest.slice(start, j), lineNo, colOf(start));
        continue;
      }

      // Strings: "..." with \n \t \" \\ escapes
      if (c === '"') {
        const start = j;
        j++;
        let text = "";
        while (j < rest.length && rest[j] !== '"') {
          if (rest[j] === "\\") {
            const nx = rest[j + 1];
            if (nx === "n") text += "\n";
            else if (nx === "t") text += "\t";
            else if (nx === '"') text += '"';
            else if (nx === "\\") text += "\\";
            else text += nx ?? "";
            j += 2;
          } else {
            text += rest[j];
            j++;
          }
        }
        if (j >= rest.length) {
          throw new LangError(
            "Syntax",
            "This piece of text is missing its closing quote.",
            lineNo,
            colOf(start),
            'Add a " at the end, like: "hello"',
          );
        }
        j++; // closing quote
        push("STRING", text, lineNo, colOf(start));
        continue;
      }

      // Identifiers & keywords
      if (isIdentStart(c)) {
        const start = j;
        while (j < rest.length && isIdentPart(rest[j])) j++;
        const word = rest.slice(start, j);
        push(KEYWORDS[word] ?? "IDENT", word, lineNo, colOf(start));
        continue;
      }

      // Two-character operators
      const two = rest.slice(j, j + 2);
      if (two === "==") { push("EQEQ", "==", lineNo, colOf(j)); j += 2; continue; }
      if (two === "!=") { push("BANGEQ", "!=", lineNo, colOf(j)); j += 2; continue; }
      if (two === "<=") { push("LTE", "<=", lineNo, colOf(j)); j += 2; continue; }
      if (two === ">=") { push("GTE", ">=", lineNo, colOf(j)); j += 2; continue; }

      // Single-character operators & punctuation
      const single = SINGLE[c];
      if (single) {
        push(single, c, lineNo, colOf(j));
        j++;
        continue;
      }

      throw new LangError(
        "Syntax",
        `I don't recognize the symbol '${c}'.`,
        lineNo,
        colOf(j),
        "Sprout doesn't use that character — double-check for a typo.",
      );
    }

    // End of a real (non-blank) line.
    push("NEWLINE", "", lineNo, line.length + 1);
  }

  // Close any open blocks at the end of the file.
  const lastLine = rawLines.length;
  while (indentStack.length > 1) {
    indentStack.pop();
    push("DEDENT", "", lastLine, 1);
  }
  push("EOF", "", lastLine, 1);
  return tokens;
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}
function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}
