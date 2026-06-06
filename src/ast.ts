// ast.ts — the shapes of a parsed Sprout program (the syntax tree).
// Every node carries a line (and usually a col) so runtime errors can point
// back at the exact spot in the source.

export type Expr =
  | { type: "Number"; value: number; line: number; col: number }
  | { type: "String"; value: string; line: number; col: number }
  | { type: "Bool"; value: boolean; line: number; col: number }
  | { type: "Identifier"; name: string; line: number; col: number }
  | { type: "Unary"; op: "-" | "not"; operand: Expr; line: number; col: number }
  | { type: "Binary"; op: string; left: Expr; right: Expr; line: number; col: number }
  | { type: "Logical"; op: "and" | "or"; left: Expr; right: Expr; line: number; col: number }
  | { type: "Call"; name: string; args: Expr[]; line: number; col: number };

export interface Branch {
  cond: Expr;
  body: Stmt[];
}

export type Stmt =
  | { type: "Let"; name: string; value: Expr; line: number; col: number }
  | { type: "Assign"; name: string; value: Expr; line: number; col: number }
  | { type: "Say"; values: Expr[]; line: number }
  | { type: "If"; branches: Branch[]; elseBody: Stmt[] | undefined; line: number }
  | { type: "While"; cond: Expr; body: Stmt[]; line: number }
  | { type: "Repeat"; count: Expr; body: Stmt[]; line: number }
  | { type: "ExprStmt"; expr: Expr; line: number };
