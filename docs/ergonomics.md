# Named inputs and multiline text

User tasks accept named inputs with `name: value`:

```sprout
task greeting(name, punctuation = "!"):
    give "Hello, " + name + punctuation

show greeting(punctuation: "?", name: "Sam")
show greeting("Pat", punctuation: ".")
show "Alex" |> greeting(punctuation: "!")
```

Positional inputs precede named inputs. A supplied name must match exactly one
parameter. Unknown names, duplicate inputs (including a positional and named
input for the same parameter), and missing required inputs fail before input
expressions execute. Renaming a task parameter therefore changes its public
named-call API and should follow the project's compatibility policy.

Explicit inputs evaluate once, from left to right as written. Omitted defaults
evaluate afterwards in declaration order in the task frame, where supplied
inputs and preceding defaults are available. Parameter and return annotations
continue to apply. Tasks held in variables, closures, module tasks, object
methods, and `super` calls support the same syntax. The receiver of a method is
implicit and cannot be replaced by a named input.

Constructors support field names, including inherited fields:

```sprout
type Point:
    make x = 0
    make y = 0

make point = Point(y: 20, x: 10)
```

Explicit constructor inputs evaluate in source order. Fields are inserted in
declaration order, with ancestor fields first. Constructor defaults retain their
existing evaluation context. An inherited and child field with the same name is
ambiguous for a named call; use distinct field names.

Builtin operations still accept positional inputs because their public parameter
names are not yet defined. Wrap a builtin in a user task when named inputs make
its API clearer. Higher-order operations invoking a task with already-evaluated
values continue to use positional binding.

Triple quotes create multiline text:

```sprout
make template = """Hello,
  This indentation is part of the text.
~ This is text, not a Sprout comment.
Brackets [ { ( do not change the surrounding expression.
"""
```

Content between the delimiters is retained, including leading/trailing newlines,
blank lines, indentation, trailing spaces, and CRLF bytes. Escape sequences have
the same behavior as ordinary quoted text. A backslash can escape a quote that
would otherwise start the closing delimiter. There is no automatic dedenting.
Diagnostics after the literal keep their physical source line numbers.

The formatter preserves literal content exactly, including blank lines and
trailing spaces, while formatting surrounding code. Plain `"""..."""` is supported;
multiline interpolated `f"""..."""` currently reports a clear error. Join values
explicitly or use ordinary single-line interpolated strings.
