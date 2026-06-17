# 🌱 Sprout Wiki Navigator

The complete map of the Sprout documentation. Every page is listed below, followed by a
**find-anything index** — every keyword, operator, builtin, command, and error kind, with a
link straight to the page that explains it.

> New here? Read [Getting started](wiki/getting-started.md), keep the
> [Cheat sheet](wiki/cheatsheet.md) open in another tab, and work down the **Language guide**
> in order. Everything below is verified against the real interpreter (Sprout v0.1.5).

---

## The pages

### Start here
| Page | What's inside |
| --- | --- |
| [Getting started](wiki/getting-started.md) | Install or build the interpreter, run your first program, the interactive REPL |
| [Cheat sheet](wiki/cheatsheet.md) | The whole language on one page |

### Language guide — read in order
| Page | What's inside |
| --- | --- |
| [Syntax basics](wiki/syntax-basics.md) | The four value types, `make` / `set` / `show`, comments, truthiness, equality, scope |
| [Operators & expressions](wiki/operators.md) | `+ - * / %`, comparisons, `and` / `or` / `not`, `in`, `or else`, the pipe `\|>`, ranges `a to b`, precedence |
| [Control flow](wiki/control-flow.md) | `when` / `orwhen` / `otherwise`, `repeat … times`, `repeat while`, `stop`, `skip` |
| [Text (strings)](wiki/text.md) | String literals, escapes, **f-strings**, character indexing `s[i]`, every text builtin |
| [Lists, maps, ranges & comprehensions](wiki/collections.md) | `[…]` lists, `{…}` maps, indexing, `for each`, ranges, `[expr for each …]` |
| [Tasks, lambdas & closures](wiki/tasks-and-lambdas.md) | `task` / `give`, recursion, first-class tasks, `map` / `filter` / `reduce`, lambdas, closures |
| [Pattern matching](wiki/pattern-matching.md) | `match` / `is` / `otherwise`, list `[a, b]` and map `{name}` destructuring |
| [Errors](wiki/errors.md) | `try` / `caught` / `fail`, the `{message, kind, line}` error map, the 7 error kinds |

### Reference
| Page | What's inside |
| --- | --- |
| [Builtins reference](wiki/builtins-reference.md) | **All 66 builtins** — signature, behavior, example, and the error each raises |
| [Grammar & decided edge cases](wiki/grammar-and-edge-cases.md) | The EBNF, indentation rules, reserved words, the rules settled at the freeze |
| [Glossary](wiki/glossary.md) | Every Sprout term, one line each |

### Tooling, projects & hosting
| Page | What's inside |
| --- | --- |
| [Command line & flags](wiki/cli-and-flags.md) | Every `sprout` command, plus `--sandbox`, `SPROUT_SANDBOX`, `SPROUT_GC_STRESS` |
| [Modules & projects](wiki/modules-and-projects.md) | `sprout.toml`, `use`, `public` / `private`, `sprout new` / `build` / `template` |
| [Testing & learn mode](wiki/testing-and-learn.md) | `test` / `expect` / `expect error`, `sprout test`, `learn on` / `off` |
| [Persistence](wiki/persistence.md) | `remember` / `recall` / `forget` and the `sprout.data.json` store |
| [Files, web, system & time](wiki/io-web-system-time.md) | `read` / `write` / `append` / `exists`, `get` / `explore`, `system.run`, `now` / `today` / `wait`, `color` |
| [Sandbox & the online playground](wiki/sandbox-and-playground.md) | `--sandbox` (what it turns off) and the Docker playground |

### Internals
| Page | What's inside |
| --- | --- |
| [How Sprout works](wiki/architecture.md) | lexer → parser → tree-walking interpreter, and the garbage collector |

---

## Find anything fast

### Keywords
| Keyword | What it does | Page |
| --- | --- | --- |
| `make` | Create a new variable | [Syntax basics](wiki/syntax-basics.md) |
| `set` | Change an existing variable (incl. `+=` `-=` `*=` `/=` `%=`) | [Syntax basics](wiki/syntax-basics.md) |
| `show` | Print values | [Syntax basics](wiki/syntax-basics.md) |
| `yes` / `no` | The two booleans | [Syntax basics](wiki/syntax-basics.md) |
| `nothing` | The absence of a value | [Syntax basics](wiki/syntax-basics.md) |
| `and` / `or` / `not` | Logical operators (short-circuit) | [Operators](wiki/operators.md) |
| `in` | Membership test (`x in things`) | [Operators](wiki/operators.md) |
| `or` `else` | Use a fallback when something is `nothing` | [Operators](wiki/operators.md) |
| `to` | Inclusive range (`1 to 5`) | [Operators](wiki/operators.md) · [Collections](wiki/collections.md) |
| `when` / `orwhen` / `otherwise` | Choices (if / else-if / else) | [Control flow](wiki/control-flow.md) |
| `repeat` / `times` / `while` | Loops | [Control flow](wiki/control-flow.md) |
| `stop` / `skip` | Leave a loop / skip the rest of a turn | [Control flow](wiki/control-flow.md) |
| `for` / `each` | Walk a list or map (`for each x in xs`) | [Collections](wiki/collections.md) |
| `task` / `give` | Define a function / return a value | [Tasks & lambdas](wiki/tasks-and-lambdas.md) |
| `match` / `is` | Pattern matching | [Pattern matching](wiki/pattern-matching.md) |
| `try` / `caught` / `fail` | Catch a soft error / raise your own | [Errors](wiki/errors.md) |
| `test` / `expect` | Built-in testing (`expect error` too) | [Testing & learn](wiki/testing-and-learn.md) |
| `learn` | Turn step-by-step narration on/off | [Testing & learn](wiki/testing-and-learn.md) |
| `use` | Import a module | [Modules & projects](wiki/modules-and-projects.md) |
| `public` / `private` | Share a name across the project (`private` is the default) | [Modules & projects](wiki/modules-and-projects.md) |

### Operators
| Operator | Meaning | Page |
| --- | --- | --- |
| `+` `-` `*` `/` `%` | Arithmetic (`+` also joins text) | [Operators](wiki/operators.md) |
| `==` `!=` `<` `<=` `>` `>=` | Comparison | [Operators](wiki/operators.md) |
| `and` `or` `not` | Logic (short-circuit; result is `yes`/`no`) | [Operators](wiki/operators.md) |
| `in` | Membership (list / map / text) | [Operators](wiki/operators.md) |
| `or else` | Nothing-coalescing fallback | [Operators](wiki/operators.md) |
| `\|>` | Pipe: `x \|> f` is `f(x)` | [Operators](wiki/operators.md) · [Tasks](wiki/tasks-and-lambdas.md) |
| `a to b` | Inclusive range | [Operators](wiki/operators.md) |
| `[ ]` | Index into text / a list / a map | [Text](wiki/text.md) · [Collections](wiki/collections.md) |
| `.` | Module member (`module.name`) | [Modules & projects](wiki/modules-and-projects.md) |
| `( )` | Grouping | [Operators](wiki/operators.md) |
| `f"… {expr} …"` | f-string (text with values inside) | [Text](wiki/text.md) |
| `~` | Comment to end of line | [Syntax basics](wiki/syntax-basics.md) |

### Builtins (all 66)
Full signatures, behavior, examples, and the error each raises live in the
**[Builtins reference](wiki/builtins-reference.md)**. Grouped:

- **Numbers & math** — `abs` `ceil` `floor` `round` `sqrt` `pow` `min` `max` `sum` `random` `seed` `number`
- **Text** — `upper` `lower` `title` `trim` `replace` `split` `join` `words` `lines` `contains` `starts_with` `ends_with` `index_of` `count` `length` `slice` → also [Text](wiki/text.md)
- **Lists** — `add` `append` `remove` `insert` `first` `last` `length` `sort` `sort_by` `reverse` `unique` `zip` `flatten` `slice` `range` `index_of` `contains` `count` → also [Collections](wiki/collections.md)
- **Maps** — `keys` `values` `length` `remove` `contains` → also [Collections](wiki/collections.md)
- **Higher-order** — `map` `filter` `reduce` → also [Tasks](wiki/tasks-and-lambdas.md)
- **Inspect & convert** — `kind_of` `copy` `json` `number`
- **Random & time** — `random` `seed` `now` `today` `wait` → also [Files, web, system & time](wiki/io-web-system-time.md)
- **Input** — `ask`
- **Files** — `read` `write` `append` `exists` → [Files, web, system & time](wiki/io-web-system-time.md)
- **Web** — `serve` `get` `explore` → [Files, web, system & time](wiki/io-web-system-time.md)
- **Persistence** — `remember` `recall` `forget` → [Persistence](wiki/persistence.md)
- **System & output** — `run` (`system.run`) · `color` → [Files, web, system & time](wiki/io-web-system-time.md)

### Command line
| Command | What it does | Page |
| --- | --- | --- |
| `sprout` | Open the interactive screen / REPL | [CLI & flags](wiki/cli-and-flags.md) |
| `sprout <file.sprout>` / `sprout run <file>` | Run a program | [CLI & flags](wiki/cli-and-flags.md) |
| `sprout test [file]` | Run tests (one file, or every `tests/*.sprout`) | [Testing & learn](wiki/testing-and-learn.md) |
| `sprout new <folder>` | Create a new project | [Modules & projects](wiki/modules-and-projects.md) |
| `sprout build` | Run the project here (reads `sprout.toml`) | [Modules & projects](wiki/modules-and-projects.md) |
| `sprout api <url>` | Show every field an API returns | [Files, web, system & time](wiki/io-web-system-time.md) |
| `sprout template list` / `load <name>` | List / scaffold project templates | [Modules & projects](wiki/modules-and-projects.md) |
| `sprout version` / `sprout help` | Show the version / the help | [CLI & flags](wiki/cli-and-flags.md) |
| `--sandbox` · `SPROUT_SANDBOX=1` | Run untrusted code safely | [Sandbox & playground](wiki/sandbox-and-playground.md) |
| `SPROUT_GC_STRESS=1` | Aggressive GC, for testing | [CLI & flags](wiki/cli-and-flags.md) |

### Error kinds
The caught error is a map `{message, kind, line}`. Full table in [Errors](wiki/errors.md).

| Kind | Triggered by |
| --- | --- |
| `error` | Generic problems (e.g. a builtin called with the wrong number of arguments) |
| `name` | An unknown variable or task — a **hard** error, not catchable (it's a typo) |
| `type` | The wrong kind of value for an operator or `[ ]`, or mixed/non-number list elements |
| `math` | Arithmetic domain errors — divide or remainder by zero, `sqrt` of a negative |
| `index` | Any out-of-range access — read, assign, `remove`, or `insert` |
| `io` | A file or network problem |
| `fail` | Raised by your own `fail "message"` |

---

<sub>🌱 Generated for Sprout v0.1.5. Every example in these pages was run against the real interpreter.</sub>
