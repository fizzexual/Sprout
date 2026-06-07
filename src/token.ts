// token.ts — the alphabet of Sprout. The lexer turns raw text into a flat
// list of these tokens, which the parser then reads.

export type TokenType =
  // literals & names
  | "NUMBER" | "STRING" | "IDENT"
  // keywords
  | "MAKE" | "SET" | "SHOW"
  | "WHEN" | "ORWHEN" | "OTHERWISE"
  | "REPEAT" | "WHILE" | "TIMES"
  | "AND" | "OR" | "NOT" | "YES" | "NO"
  | "TASK" | "GIVE" | "STYLE"
  // operators
  | "PLUS" | "MINUS" | "STAR" | "SLASH" | "PERCENT"
  | "EQ" | "EQEQ" | "BANGEQ" | "LT" | "LTE" | "GT" | "GTE"
  // punctuation
  | "LPAREN" | "RPAREN" | "COMMA" | "COLON"
  // structure
  | "NEWLINE" | "INDENT" | "DEDENT" | "EOF";

export interface Token {
  type: TokenType;
  value: string; // the literal text (for STRING, the already-unescaped contents)
  line: number;
  col: number;
}
