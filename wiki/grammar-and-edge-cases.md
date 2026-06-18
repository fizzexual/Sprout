# Grammar & decided edge cases

The precise rules — the EBNF grammar, exactly how indentation works, the full list of reserved words, and every corner case that was argued about once and then settled for good. This is the page to reach for when you need *the answer*, not the friendly version.

If you're just learning the language, start with [getting-started](getting-started.md) and [sprout syntax](syntax-basics.md) instead — this page is the reference under them. Everything here was checked against the real interpreter, and the output blocks are pasted verbatim from running it.

## On this page

- [How to read this page](#how-to-read-this-page)
- [The grammar (core EBNF)](#the-grammar-core-ebnf)
- [Indentation rules](#indentation-rules)
  - [The colon and the block](#the-colon-and-the-block)
  - [INDENT / DEDENT](#indent--dedent)
  - [Tabs vs spaces](#tabs-vs-spaces)
  - [Implicit line-joining inside ( ) [ ] { }](#implicit-line-joining-inside------)
- [Reserved words & identifiers](#reserved-words--identifiers)
- [Operator precedence](#operator-precedence)
- [Decided edge cases (settled at v0.0.13)](#decided-edge-cases-settled-at-v0013)
  - [Numbers: precision, formatting, overflow](#numbers-precision-formatting-overflow)
  - [Division and modulo by zero](#division-and-modulo-by-zero)
  - [Indexing and out-of-range](#indexing-and-out-of-range)
  - [Mutate-vs-return](#mutate-vs-return)
  - [Shared references and copy()](#shared-references-and-copy)
  - [Equality never crashes](#equality-never-crashes)
  - [The smaller settled rules](#the-smaller-settled-rules)
- [Not in the core (on purpose)](#not-in-the-core-on-purpose)
- [See also](#see-also)

---

## How to read this page

A few of these rules describe things that are **errors** — like indexing past the end of a list. For those, the second code block shows the real error message the interpreter prints, not a value. That's deliberate: a friendly, exact error message *is* the behavior, and it's worth knowing what it says.

The grammar is **descriptive, not a formal spec** — the source code is the final word — but it's exact enough to settle "is this legal?" questions and spot ambiguities.

---

## The grammar (core EBNF)

`INDENT`, `DEDENT`, and `NEWLINE` are produced by the lexer (see [Indentation rules](#indentation-rules) below). Everything else is ordinary recursive-descent.

```ebnf
program    = { statement } ;
statement  = make | set | show | when | repeat | foreach
           | task | type | give | use | learn | try | fail | "stop" | "skip"
           | ( expr NEWLINE ) ;

make       = [ "public" | "private" ] "make" ident "=" expr NEWLINE ;
set        = "set" ( ident | postfix ) assign expr NEWLINE ;
assign     = "=" | "+=" | "-=" | "*=" | "/=" | "%=" ;
                         (* compound: x op= e  ==  x = x op e; target must already exist *)
show       = "show" expr { "," expr } NEWLINE ;
                         (* commas print with a single space between *)
when       = "when" expr block { "orwhen" expr block } [ "otherwise" block ] ;
repeat     = "repeat" ( expr "times" | "while" expr ) block ;
                         (* a 'times' count is truncated to a whole number; <= 0 runs 0 times *)
foreach    = "for" "each" ident [ "," ident ] "in" expr block ;
                         (* 1 name: item / map-key.
                            2 names: (index,item) over list/text, (key,value) over a map *)
task       = [ "public" | "private" ] "task" ident "(" [ ident { "," ident } ] ")" block ;
                         (* top level only — a named task inside a block is a parse error *)
give       = "give" [ expr ] NEWLINE ;                 (* a parse error outside a task *)
try        = "try" block "caught" [ ident ] block ;
                         (* caught is required; ident binds the error map {message,kind,line} *)
fail       = "fail" [ expr ] NEWLINE ;
                         (* a map is carried whole, else wrapped as {message,kind:"fail",line} *)
use        = "use" ( ident | string ) NEWLINE ;
                         (* a path-looking target (has / \ or .sprout) is literal;
                            otherwise it's a searched module name *)
learn      = "learn" ( "on" | "off" ) NEWLINE ;
block      = ":" NEWLINE INDENT { statement } DEDENT ;
                         (* "stop"/"skip" only inside a loop body *)

expr       = or ;
or         = and { ( "or" "else" and )                 (* nothing-coalescing: left unless nothing *)
                  | ( "or" and ) } ;                    (* logical or *)
and        = cmp { "and" cmp } ;
cmp        = term [ ( "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" ) term ] ;
                         (* non-associative; comparisons don't chain. `x in xs` = membership *)
term       = factor { ( "+" | "-" ) factor } ;
factor     = unary { ( "*" | "/" | "%" ) unary } ;
unary      = ( "-" | "not" ) unary | postfix ;
postfix    = primary { "[" expr "]" } ;
primary    = number | string | fstring | "yes" | "no" | "nothing"
           | list | map | "(" expr ")"
           | ident [ "." ident ] [ "(" [ expr { "," expr } ] ")" ] ;
list       = "[" [ expr { "," expr } ] "]" ;
map        = "{" [ key ":" expr { "," key ":" expr } ] "}" ;
key        = ident | string ;
fstring    = 'f"' { char | "{" expr "}" } '"' ;
number     = digits [ "." digits ] [ ("e"|"E") ["+"|"-"] digits ] ;   (* 42, 2.5, 1e3, 1.5e-2 *)
```

A few things the grammar quietly settles that are easy to miss:

- **`a.b.c` is a syntax error.** `primary` allows a *single* `.ident` — module member access (`server.start`) is one dot only. Index access (`x[i][j]`) can nest as deep as you like, but member access can't.
- **`stop` / `skip` are bare statements** with no expression, and the lexer/parser only permit them inside a loop body. Outside a loop they're a parse-time error.
- **`give` is a parse error outside a task** — it's how the parser keeps "return" meaningful only where it can mean something.
- **A map `key` is `ident` or `string`** — a bare identifier key is shorthand for its *text*, and keys are never evaluated as variables. So `{name: 1}` has the key `"name"`, and even reserved words work as keys (`{in: 1, set: 2}`), since they're just text in that position. See [collections](collections.md).
- **The number rule covers scientific notation** — `1e3`, `2.5e-2`, `1E6` are all literals.
- **Ranges (`a to b`) and comprehensions** aren't in the trimmed core grammar above, but they're real expression forms (`to` binds between comparisons and `+`/`-`). See [operators](operators.md).

```sprout
make cfg = {in: 1, set: 2, for: 3, name: "ok"}
show cfg["in"], cfg["set"], cfg["for"], cfg["name"]
```

```
1 2 3 ok
```

---

## Indentation rules

Sprout uses indentation to mark blocks, like Python — but the rules are simpler than Python's, with no fixed tab size and one extra trick (implicit line-joining inside brackets).

### The colon and the block

Every block is opened by a `:` at the end of a line, then a `NEWLINE`, then an **indented** group of statements. The block ends when the indentation comes back out (a `DEDENT`). This is the `block` rule from the grammar:

```ebnf
block = ":" NEWLINE INDENT { statement } DEDENT ;
```

So a `when`, `repeat`, `for each`, `task`, `try`/`caught`, and a multi-line lambda body all end their header line with `:` and indent the body:

```sprout
when yes:
    show "the body is indented under the colon"
```

```
the body is indented under the colon
```

### INDENT / DEDENT

- **Any** increase in indentation opens a block. There's **no fixed unit** — whatever you indent by (4 spaces, 2 spaces, 1 tab) becomes the unit for that block. Most code uses 4 spaces; consistency within a file is what matters.
- A decrease in indentation must return **exactly** to a level you were at before. If it lands between two levels, you get a clear error rather than a guess.
- **Blank lines and comment-only lines (`~ ...`) don't affect indentation** — you can space your code out freely.

Here's what a mis-aligned dedent looks like — the third line is indented 2 spaces, which matches no open level:

```sprout
when yes:
    show "a"
  show "b"
```

```
  Sprout error in ... (line 3): the indentation doesn't line up with the block.
```

### Tabs vs spaces

**A tab counts as one column — the same as one space.** That makes tab-only indentation work fine on its own:

```sprout
when yes:
	show "tab-indented body works"
```

```
tab-indented body works
```

But because a tab is exactly *one* column, **mixing tabs and spaces will misalign your levels** — four spaces and one tab look the same in your editor but count as 4 vs 1 to the lexer. The rule of thumb is the usual one: pick spaces *or* tabs for a file and don't mix them.

### Implicit line-joining inside ( ) [ ] { }

Inside parentheses, square brackets, or curly braces, **newlines and indentation are ignored** *(since v0.0.28)*. A list, map, or call can span as many lines as you like, and a **trailing comma** is allowed — so each item gets its own line and reorders cleanly in diffs:

```sprout
make people = [
    {name: "Ada", age: 36},
    {name: "Mo",  age: 17},
]
show length(people)
show people[0]["name"]

make total = sum([
    1,
    2,
    3,
])
show total
```

```
2
Ada
6
```

Two limits to remember:

- **Text literals still can't span source lines.** A string is single-line; join with `\n` instead. (Multi-line string syntax is deliberately not in the core.)
- **A lambda inside a multi-line `[ ]` / `{ }` / `( )` must use a one-line body.** Newlines are ignored in there, so a multi-step `when`/block body can't be detected. If you need a multi-step lambda in a literal, `make` it with a name first and use the name — and Sprout tells you this if you hit it. See [tasks & lambdas](tasks-and-lambdas.md).

---

## Reserved words & identifiers

**Identifiers** start with a letter or `_`, then letters / digits / `_` (ASCII), and are **case-sensitive** — `Name` and `name` are two different variables.

**Keywords** are reserved; you can't use them as variable or task names:

```
make set show when orwhen otherwise repeat while times task type give
for each in to match is use public private learn test expect and or not
yes no nothing try caught fail stop skip
```

That's the complete set of 34. A few notes on the ones that surprise people:

- **`else` is *not* reserved.** It's only meaningful right after `or` (the `or else` nothing-coalescing operator). Anywhere else, `else` is an ordinary name you can use.
- **`learn on` / `learn off`** use `on` / `off` as contextual words after `learn` — they aren't separate reserved keywords. Same with **`expect error`** (the word `error` is contextual there).
- **`otherwise` vs `caught`** are separate words on purpose: `otherwise` is the else-branch of `when`; `caught` is the catch-block of `try`. Keeping them distinct means each header reads as exactly one thing.
- **`orwhen`** is the committed spelling for "else-if" — one word, not `else when` or `or when`.

**Built-in functions** are predefined *names*, not keywords. You *may* shadow one with your own variable (`make length = 5`), and the function stays callable as a function — but it's clearer not to. The 66 builtins are listed and explained in [builtins reference](builtins-reference.md). There's also one reserved built-in module name: you can't define your own module called `system`.

---

## Operator precedence

From the grammar, loosest to tightest binding:

| Level | Operators | Notes |
| --- | --- | --- |
| `or` | `or`, `or else` | logical or / nothing-coalescing |
| `and` | `and` | binds **tighter** than `or` |
| `cmp` | `== != < <= > >=`, `in` | **non-associative** — comparisons don't chain |
| (range) | `a to b` | inclusive range, between compare and `+`/`-` |
| `term` | `+ -` | `+` also joins text |
| `factor` | `* / %` | |
| `unary` | `-x`, `not x` | |
| `postfix` | `x[i]` | indexing |
| `primary` | literals, `( )`, `name`, `name.member`, calls | |

Two consequences worth pinning down:

`and` binds tighter than `or`, so `a or b and c` means `a or (b and c)`:

```sprout
show yes or no and no
show 2 + 3 * 4
show (2 + 3) * 4
```

```
yes
14
20
```

**Comparisons don't chain** — `1 < 2 < 3` is a friendly error, not `(1 < 2) < 3`. Write it with `and`:

```sprout
show 1 < 2 < 3
```

```
  Sprout error in ... (line 1): comparisons can't be chained - use 'and', like  a < b and b < c.
```

The fix is `1 < 2 and 2 < 3`. The `in` membership operator lives at the same non-chaining level, and works on lists (items), maps (keys), and text (substrings) — see [operators](operators.md) for the full table.

---

## Decided edge cases (settled at v0.0.13)

These are the corners that were argued about once and then locked, because programs and libraries depend on them and they mustn't drift. One clear rule each.

### Numbers: precision, formatting, overflow

There is **one number type** — IEEE-754 double. No separate integer type. That has a few visible consequences, all settled:

- **`5 / 2` is `2.5`.** Division is real division; it doesn't floor.
- **Whole-number values display without a decimal point.** `range(3)` is `[0, 1, 2]` and `length([1,2,3])` reads `3`, not `3.0` — so the doubles-only choice is invisible until you do real division.
- **Very large whole numbers fall back to exponential form at `1e15`.** A whole number *below* `1e15` prints in full; at `1e15` and above it switches to `1e+15`-style notation (and that's also where precision starts to be lost, since doubles can't hold every large integer exactly).
- **Scientific-notation literals are accepted** — `1e3` is `1000`, `2.5e-2` is `0.025`.

```sprout
show 5 / 2
show range(3)
show 999999999999999
show 1000000000000000
show 1e21
show 1e3, 2.5e-2
```

```
2.5
[0, 1, 2]
999999999999999
1e+15
1e+21
1000 0.025
```

`nan` and `inf` aren't reachable through normal paths, because the operations that would produce them (divide by zero, `sqrt` of a negative) are runtime errors instead — see below.

### Division and modulo by zero

Dividing or taking the remainder by zero is a runtime error with kind `"math"` (catchable with [try / caught](errors.md)). And **`%` takes the sign of the left operand** (it's `fmod`):

```sprout
show (0 - 7) % 3
show 7 % (0 - 3)
show 10 % 3
```

```
-1
1
1
```

If you wrap a divide-by-zero in `try`, you can see the exact error map:

```sprout
try:
    show 1 / 0
caught problem:
    show problem
```

```
{message: you tried to divide by zero., kind: math, line: 2}
```

The caught value is always a **map** with `message`, `kind`, and `line` — see [errors](errors.md) for the full stable list of `kind`s.

### Indexing and out-of-range

- **Indexing is non-negative and never auto-grows.** `xs[-1]` is an error — use `last(xs)`. An out-of-range position is an error too; lists don't extend by being written past their end.
- **`first([])` / `last([])` error** on an empty list, rather than silently giving `nothing`, so a beginner sees the real cause.

```sprout
show [10, 20][0 - 1]
```

```
  Sprout error in ... (line 1): that position doesn't exist in the list (positions start at 0; for the end use last(...)).
```

```sprout
show first([])
```

```
  Sprout error in ... (line 1): first() needs a list with at least one item (this list is empty).
```

(All out-of-range positions — read, assign, or remove, on lists *or* text — raise kind `"index"`.)

### Mutate-vs-return

This is the convention every collection builtin follows, and it's worth memorizing once:

- **`add` / `insert` change a list and return `nothing`** — they're commands, not expressions.
- **`remove` changes the list/map and returns the removed item** (or `nothing` if a map key was absent).
- **`sort` / `reverse` change the list *in place* and return the *same* list** (a reference, not a copy) — so `show sort(xs)` works *and* `xs` is now sorted.
- **`copy` is the only one that returns a brand-new value.**

```sprout
make xs = [3, 1, 2]
show add(xs, 5)
show insert(xs, 0, 7)
show remove(xs, 0)
make same = sort(xs)
show same
show same == xs
```

```
nothing
nothing
7
[1, 2, 3, 5]
yes
```

The "batteries" builtins (`sum`, `unique`, `zip`, `flatten`, `slice`, …) never mutate — they all return new values. Full details in [builtins reference](builtins-reference.md).

### Shared references and copy()

**Lists and maps are shared references — this is load-bearing.** `make b = a` does *not* copy; `a` and `b` are the *same* list/map. So mutating one is visible through the other, and passing a list into a task lets the task change the caller's value. (Numbers, `yes`/`no`, `nothing`, and text are immutable value types — only lists and maps are shared.) When you need an independent snapshot, use **`copy(x)`**, which is a *deep* copy.

```sprout
make a = [1, 2]
make b = a
add(b, 3)
show a

make snap = copy(a)
add(a, 4)
show snap
show a
```

```
[1, 2, 3]
[1, 2, 3]
[1, 2, 3, 4]
```

The first `show a` is `[1, 2, 3]` because `b` *is* `a`. Then `snap` is a deep copy taken before the next mutation, so it stays `[1, 2, 3]` while `a` grows to `[1, 2, 3, 4]`. See [collections](collections.md) for more on aliasing.

### Equality never crashes

`==` and `!=` work across **any** two values and never error — different kinds are simply never equal:

```sprout
show 5 == "5"
show number("abc")
show number("42")
```

```
no
nothing
42
```

`5 == "5"` is `no` (a number and text are different kinds). And `number("abc")` is **`nothing`**, *not* an error — so you can safely test user input with `when number(x) == nothing: …` or fall back with `number(x) or else 0`. Equality is also **deep and structural** for lists and maps (and map key *order* doesn't affect equality, even though it's preserved for iteration).

### The smaller settled rules

A handful more, each one rule:

- **String escapes** `\n` `\t` `\"` `\\` are real characters in text and f-strings (plus `\{` `\}` inside f-strings).
- **Text is single-line** — a string literal can't span source lines. Join with `\n`.
- **Using `nothing` wrongly is a friendly error.** `nothing[0]` and `nothing + 1` say so plainly instead of guessing — `"I can't add nothing and a different kind of value."` and `"you tried to look inside 'nothing' with [ ] - there's nothing there to index."`.
- **`when` with no matching branch and no `otherwise` does nothing.**
- **`give` with no value, and a task that never `give`s, both return `nothing`.**
- **A task's name *is* a value** — `make f = greet` stores it; `f(...)` calls it. Calling a non-task with `( )` is a friendly error. See [tasks & lambdas](tasks-and-lambdas.md).
- **`make` on a name that already exists in the same scope is an error** — a typo'd `make` can never silently become a reassignment:

```sprout
make x = 1
make x = 2
```

```
  Sprout error in ... (line 2): 'x' already exists here - use 'set' to change it (make is only for new names).
```

One more rule that pairs with this, about error tiers: **`try` catches runtime conditions but deliberately *not* code mistakes.** An unknown variable, task, or module (the "did you mean?" errors) is a *hard* error that skips every enclosing `try` and surfaces its diagnostic — so wrapping a block in `try` can never silently swallow a typo:

```sprout
try:
    show undefinedname
caught e:
    show "caught it:", e["kind"]
```

```
  Sprout error in ... (line 2): I don't know what 'undefinedname' is.

  Variables are made with 'make', like:
      make undefinedname = "Sam"
```

The `caught` block never ran — the typo is uncatchable by design. See [errors](errors.md) for the hard-vs-soft tiers and the full `kind` table.

---

## Not in the core (on purpose)

A few things you won't find, and these are decisions, not gaps:

- **No user-defined types / structs / classes** — a **map** is the record type.
- **No multi-line string syntax** — join with `\n`.
- **No negative indexing** — use `last(xs)`.
- **No separate integer type** — numbers are doubles, with the display and overflow rules above.

Each was left out so there's one obvious way to do the thing.

---

## See also

- [getting started](getting-started.md) — install and your first program
- [sprout syntax](syntax-basics.md) — the friendly walk through every construct
- [operators](operators.md) — the full operator table, `in`, `or else`, `|>`, ranges
- [collections](collections.md) — lists, maps, aliasing, and `copy`
- [tasks & lambdas](tasks-and-lambdas.md) — named tasks, closures, first-class tasks
- [pattern matching](pattern-matching.md) — `match` / `is` / `otherwise`
- [errors](errors.md) — `try` / `caught` / `fail`, the `kind` table, hard vs soft
- [builtins reference](builtins-reference.md) — all 66 built-in functions
- [cli & flags](cli-and-flags.md) — the `sprout` commands, `--sandbox`, env vars
- [cheatsheet](cheatsheet.md) — the whole language on one page
