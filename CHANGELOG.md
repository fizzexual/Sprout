# Changelog

All notable changes to **Sprout**. The format follows
[Keep a Changelog](https://keepachangelog.com/); each heading is the version printed by
`sprout version`. Binaries for each release are on the
[Releases](https://github.com/fizzexual/Sprout/releases) page.

## [0.1.17] — Capability hardening (the "9/10" pass)

A dogfooding pass that built real programs across every axis, then closed the gaps it found.

### Added
- **`super`** — a method can call the parent type's version: `give super.area() + extra`. Resolves
  from the type the method is defined on, so it walks up exactly one level (chained `super` works).
- **Regex alternation and capture groups** — `cat|dog`, `gr(a|e)y`, `(ab)+`, and a new
  **`captures(text, pattern)`** that returns `[whole, group1, group2, …]` for extraction. The
  matcher is now a continuation-passing tree walker; the step budget still bounds backtracking.
- **`code(char)` / `char(number)`** — convert between a character and its byte value (`code("A")` →
  65, `char(65)` → `"A"`).
- **`is_number(text)`** — yes/no without converting (pairs with the existing `number(...) or else …`).
- **List concatenation and repetition with `+` / `*`** — `[1, 2] + [3, 4]`, `[0] * 5`, and
  `"=" * 40`; maps merge with `+` (right side wins on shared keys).

### Changed
- **Whole numbers print in full** instead of scientific notation (`100000000000000000000`, not
  `1e+20`), and fractions show the shortest decimal that round-trips — so `0.1 + 0.2` tells the
  truth (`0.30000000000000004`), matching Java/JavaScript. (Numbers are still IEEE-754 doubles.)

## [0.1.16] — Package manager

### Added
- **`sprout add <source>`** — install a library from a local path, an `https://` URL, or a
  `github:user/repo` shorthand. It lands in `sprout_packages/<name>.sprout`, where `use <name>`
  finds it, and is recorded in a `sprout.packages` manifest.
- **`sprout install`** — fetch every library listed in `sprout.packages`, so a project can be
  shared and restored without committing its dependencies.
- **`sprout remove <name>`** — uninstall a library and drop it from the manifest.

## [0.1.15] — Code formatter

### Added
- **`sprout format`** — a `gofmt`-style code formatter. Re-indents to 4 spaces per block level,
  trims trailing whitespace, collapses blank runs, and ends the file with one newline. It's
  structure- and comment-preserving, idempotent, and prints to stdout by default (`--write`
  edits in place, `--check` is a CI gate). `sprout fmt` is a shorthand.

## [0.1.14] — Standalone executables

### Added
- **`sprout bundle <file>`** — package a program into a single native executable that runs on
  its own, with no interpreter or source file needed.

## [0.1.13] — Collection power tools

### Added
- `group_by`, `min_by` / `max_by`, `partition`, and `chunk` — higher-order data tools alongside
  `map` / `filter` / `reduce` / `sort_by`.

## [0.1.12] — Date & time

### Added
- A moment is a number (Unix seconds): `time`, `time_parts`, `time_make`, `time_format`, and
  the duration helpers `days` / `hours` / `minutes`.

## [0.1.11] — Operator overloading

### Added
- A `type` can define `plus` / `minus` / `multiply` / `divide` / `modulo`, `equals`, `compare`,
  and `text`, so `+ - * / == <` and `show` work on your own types.

## [0.1.10] — Regular expressions

### Added
- A from-scratch regex engine: `matches`, `find`, `find_all` — character classes, the `\d \w \s`
  shorthands, anchors, and greedy quantifiers `* + ? {n,m}`.

## [0.1.9] — Standard-library essentials

### Added
- Math `sin` / `cos` / `tan` / `exp` / `log` / `pi`; `args()` for command-line arguments;
  `env()` for environment variables.

## [0.1.8] — Inheritance

### Added
- `type Dog from Animal:` — single inheritance with virtual dispatch, and `is_a()` (instanceof).

## [0.1.7] — Classes & objects

### Added
- The **`type`** keyword: classes with fields and methods, construction, field access, and
  polymorphism.

## [0.1.6] — A general-purpose language

### Removed
- The `serve()` HTTP server and the store website demo. Sprout is a general-purpose software
  language, not a web framework. (The HTTP *client* `get`, plus `json` and `explore`, stayed.)

## [0.1.3] – [0.1.5]

### Added
- String garbage collection, performance work, and (briefly) a native HTTP server — see the
  Git history for the details.

## [0.1.0] — The freeze ❄️

### Added
- The frozen core of the language: values (numbers, text, yes/no, nothing, lists, maps), `make`
  / `set` / `show`, `when` / `repeat` / `for each`, `task`s with lambdas and closures, pattern
  matching (`match` / `is`), error handling (`try` / `caught` / `fail`), modules, a conservative
  mark-sweep garbage collector, built-in testing (`test` / `expect`), and persistence
  (`remember` / `recall`).

[0.1.17]: https://github.com/fizzexual/Sprout/releases/tag/v0.1.17
[0.1.16]: https://github.com/fizzexual/Sprout/releases/tag/v0.1.16
[0.1.15]: https://github.com/fizzexual/Sprout/releases/tag/v0.1.15
[0.1.14]: https://github.com/fizzexual/Sprout/releases/tag/v0.1.14
[0.1.13]: https://github.com/fizzexual/Sprout/releases/tag/v0.1.13
[0.1.12]: https://github.com/fizzexual/Sprout/releases/tag/v0.1.12
[0.1.11]: https://github.com/fizzexual/Sprout/releases/tag/v0.1.11
[0.1.10]: https://github.com/fizzexual/Sprout/releases/tag/v0.1.10
[0.1.9]: https://github.com/fizzexual/Sprout/releases/tag/v0.1.9
[0.1.8]: https://github.com/fizzexual/Sprout/releases/tag/v0.1.8
[0.1.7]: https://github.com/fizzexual/Sprout/releases/tag/v0.1.7
[0.1.6]: https://github.com/fizzexual/Sprout/releases/tag/v0.1.6
[0.1.0]: https://github.com/fizzexual/Sprout/releases/tag/v0.1.0
