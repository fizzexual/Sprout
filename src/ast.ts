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
  // make x = expr   (create a variable)
  | { type: "Make"; name: string; value: Expr; line: number; col: number }
  // set x = expr    (change an existing variable)
  | { type: "Set"; name: string; value: Expr; line: number; col: number }
  // show a, b, c    (print)
  | { type: "Show"; values: Expr[]; line: number }
  // when / orwhen / otherwise
  | { type: "When"; branches: Branch[]; otherwiseBody: Stmt[] | undefined; line: number }
  // repeat while cond:
  | { type: "RepeatWhile"; cond: Expr; body: Stmt[]; line: number }
  // repeat N times:
  | { type: "RepeatTimes"; count: Expr; body: Stmt[]; line: number }
  // task name(params):  (define a function)
  | { type: "Task"; name: string; params: string[]; body: Stmt[]; line: number; col: number }
  // give expr  (return a value from a task)
  | { type: "Give"; value: Expr | undefined; line: number; col: number }
  // style "theme.bloom"  (attach a Bloom stylesheet)
  | { type: "Style"; value: Expr; line: number; col: number }
  | { type: "ExprStmt"; expr: Expr; line: number };
