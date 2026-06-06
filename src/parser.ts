// parser.ts — turns a flat list of tokens into a syntax tree (AST).
//
// This is a hand-written recursive-descent parser. Each grammar rule is one
// method. Operator precedence is encoded as a ladder of methods, from lowest
// precedence (or) down to highest (primary values).

import { LangError } from "./errors.ts";
import type { Token, TokenType } from "./token.ts";
import type { Branch, Expr, Stmt } from "./ast.ts";

const BINOP: Partial<Record<TokenType, string>> = {
  EQEQ: "==", BANGEQ: "!=",
  LT: "<", LTE: "<=", GT: ">", GTE: ">=",
  PLUS: "+", MINUS: "-", STAR: "*", SLASH: "/", PERCENT: "%",
};

class Parser {
  tokens: Token[];
  pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  // --- token helpers -------------------------------------------------------

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private peekNext(): Token | undefined {
    return this.tokens[this.pos + 1];
  }
  private previous(): Token {
    return this.tokens[this.pos - 1];
  }
  private isAtEnd(): boolean {
    return this.peek().type === "EOF";
  }
  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }
  private advance(): Token {
    if (!this.isAtEnd()) this.pos++;
    return this.previous();
  }
  private match(...types: TokenType[]): boolean {
    for (const t of types) {
      if (this.check(t)) {
        this.advance();
        return true;
      }
    }
    return false;
  }
  private expect(type: TokenType, message: string, hint?: string): Token {
    if (this.check(type)) return this.advance();
    const tok = this.peek();
    throw new LangError("Syntax", message, tok.line, tok.col, hint);
  }

  // --- program & statements ------------------------------------------------

  parseProgram(): Stmt[] {
    const stmts: Stmt[] = [];
    while (!this.isAtEnd()) {
      if (this.check("NEWLINE") || this.check("DEDENT")) {
        this.advance();
        continue;
      }
      if (this.check("INDENT")) {
        const tok = this.peek();
        throw new LangError(
          "Indentation",
          "This line is indented but isn't inside a block.",
          tok.line,
          1,
          "Only indent lines that belong under an 'if', 'while', or 'repeat'.",
        );
      }
      stmts.push(this.statement());
    }
    return stmts;
  }

  private statement(): Stmt {
    const t = this.peek();
    switch (t.type) {
      case "LET": return this.letStmt();
      case "SAY": return this.sayStmt();
      case "IF": return this.ifStmt();
      case "WHILE": return this.whileStmt();
      case "REPEAT": return this.repeatStmt();
      default:
        if (t.type === "IDENT" && this.peekNext()?.type === "EQ") return this.assignStmt();
        return this.exprStmt();
    }
  }

  private letStmt(): Stmt {
    const kw = this.advance(); // LET
    const name = this.expect("IDENT", "I expected a name after 'let'.", "Like: let score = 0");
    this.expect("EQ", `I expected an '=' after '${name.value}'.`, `Like: let ${name.value} = 0`);
    const value = this.expression();
    this.endStatement();
    return { type: "Let", name: name.value, value, line: kw.line, col: kw.col };
  }

  private assignStmt(): Stmt {
    const name = this.advance(); // IDENT
    this.expect("EQ", "I expected an '=' here.");
    const value = this.expression();
    this.endStatement();
    return { type: "Assign", name: name.value, value, line: name.line, col: name.col };
  }

  private sayStmt(): Stmt {
    const kw = this.advance(); // SAY
    const values: Expr[] = [this.expression()];
    while (this.match("COMMA")) values.push(this.expression());
    this.endStatement();
    return { type: "Say", values, line: kw.line };
  }

  private ifStmt(): Stmt {
    const kw = this.advance(); // IF
    const branches: Branch[] = [];
    branches.push({ cond: this.expression(), body: this.block() });
    while (this.check("ELIF")) {
      this.advance();
      branches.push({ cond: this.expression(), body: this.block() });
    }
    let elseBody: Stmt[] | undefined;
    if (this.check("ELSE")) {
      this.advance();
      elseBody = this.block();
    }
    return { type: "If", branches, elseBody, line: kw.line };
  }

  private whileStmt(): Stmt {
    const kw = this.advance(); // WHILE
    const cond = this.expression();
    const body = this.block();
    return { type: "While", cond, body, line: kw.line };
  }

  private repeatStmt(): Stmt {
    const kw = this.advance(); // REPEAT
    const count = this.expression();
    this.expect("TIMES", "I expected the word 'times' here.", "Like: repeat 3 times:");
    const body = this.block();
    return { type: "Repeat", count, body, line: kw.line };
  }

  private exprStmt(): Stmt {
    const expr = this.expression();
    this.endStatement();
    return { type: "ExprStmt", expr, line: expr.line };
  }

  // A statement ends at a NEWLINE (or naturally at the end of a block / file).
  private endStatement(): void {
    if (this.check("NEWLINE")) {
      this.advance();
      return;
    }
    if (this.isAtEnd() || this.check("DEDENT")) return;
    const tok = this.peek();
    throw new LangError(
      "Syntax",
      `I didn't expect '${tok.value || tok.type}' right here.`,
      tok.line,
      tok.col,
      "Each statement should sit on its own line.",
    );
  }

  // A block is ':' then an indented group of statements.
  private block(): Stmt[] {
    this.expect("COLON", "I expected a ':' to start the block.", "Like: if score > 0:");
    this.expect("NEWLINE", "The block should begin on the next line.");
    this.expect(
      "INDENT",
      "I expected the next lines to be indented (that's the body of the block).",
      "Indent the lines inside by 4 spaces.",
    );
    const stmts: Stmt[] = [];
    while (!this.check("DEDENT") && !this.isAtEnd()) {
      if (this.check("NEWLINE")) {
        this.advance();
        continue;
      }
      stmts.push(this.statement());
    }
    this.expect("DEDENT", "I expected this block to finish here.");
    return stmts;
  }

  // --- expressions (precedence ladder, lowest to highest) ------------------

  private expression(): Expr {
    return this.or();
  }

  private or(): Expr {
    let left = this.and();
    while (this.check("OR")) {
      const op = this.advance();
      const right = this.and();
      left = { type: "Logical", op: "or", left, right, line: op.line, col: op.col };
    }
    return left;
  }

  private and(): Expr {
    let left = this.equality();
    while (this.check("AND")) {
      const op = this.advance();
      const right = this.equality();
      left = { type: "Logical", op: "and", left, right, line: op.line, col: op.col };
    }
    return left;
  }

  private equality(): Expr {
    let left = this.comparison();
    while (this.check("EQEQ") || this.check("BANGEQ")) {
      const op = this.advance();
      const right = this.comparison();
      left = { type: "Binary", op: BINOP[op.type]!, left, right, line: op.line, col: op.col };
    }
    return left;
  }

  private comparison(): Expr {
    let left = this.term();
    while (this.check("LT") || this.check("LTE") || this.check("GT") || this.check("GTE")) {
      const op = this.advance();
      const right = this.term();
      left = { type: "Binary", op: BINOP[op.type]!, left, right, line: op.line, col: op.col };
    }
    return left;
  }

  private term(): Expr {
    let left = this.factor();
    while (this.check("PLUS") || this.check("MINUS")) {
      const op = this.advance();
      const right = this.factor();
      left = { type: "Binary", op: BINOP[op.type]!, left, right, line: op.line, col: op.col };
    }
    return left;
  }

  private factor(): Expr {
    let left = this.unary();
    while (this.check("STAR") || this.check("SLASH") || this.check("PERCENT")) {
      const op = this.advance();
      const right = this.unary();
      left = { type: "Binary", op: BINOP[op.type]!, left, right, line: op.line, col: op.col };
    }
    return left;
  }

  private unary(): Expr {
    if (this.check("MINUS") || this.check("NOT")) {
      const op = this.advance();
      const operand = this.unary();
      return {
        type: "Unary",
        op: op.type === "MINUS" ? "-" : "not",
        operand,
        line: op.line,
        col: op.col,
      };
    }
    return this.primary();
  }

  // A function call: name(arg, arg, ...). The IDENT has already been read.
  private finishCall(nameTok: Token): Expr {
    this.advance(); // LPAREN
    const args: Expr[] = [];
    if (!this.check("RPAREN")) {
      args.push(this.expression());
      while (this.match("COMMA")) args.push(this.expression());
    }
    this.expect("RPAREN", "I expected a ')' to close this function call.");
    return { type: "Call", name: nameTok.value, args, line: nameTok.line, col: nameTok.col };
  }

  private primary(): Expr {
    const t = this.peek();
    if (this.match("NUMBER")) return { type: "Number", value: Number(t.value), line: t.line, col: t.col };
    if (this.match("STRING")) return { type: "String", value: t.value, line: t.line, col: t.col };
    if (this.match("TRUE")) return { type: "Bool", value: true, line: t.line, col: t.col };
    if (this.match("FALSE")) return { type: "Bool", value: false, line: t.line, col: t.col };
    if (this.check("IDENT")) {
      const nameTok = this.advance();
      if (this.check("LPAREN")) return this.finishCall(nameTok);
      return { type: "Identifier", name: nameTok.value, line: nameTok.line, col: nameTok.col };
    }
    if (this.match("LPAREN")) {
      const inner = this.expression();
      this.expect("RPAREN", "I expected a ')' to close this group.");
      return inner;
    }

    if (t.type === "NEWLINE" || t.type === "EOF") {
      throw new LangError(
        "Syntax",
        "The line ended, but I was still waiting for a value.",
        t.line,
        t.col,
        "An operator near the end might be missing something after it.",
      );
    }
    throw new LangError(
      "Syntax",
      `I didn't expect '${t.value || t.type}' here.`,
      t.line,
      t.col,
      "I was looking for a value — a number, some text, true/false, or a name.",
    );
  }
}

export function parse(tokens: Token[]): Stmt[] {
  return new Parser(tokens).parseProgram();
}
