# Text (strings)

Everything about working with words in Sprout: how to write text, glue it
together, drop values into it with f-strings, pull out single characters, and the
full set of text built-ins. Sprout's text is UTF-8 and beginner-friendly — `"é"`
is one character, not two. Every example below was run with the real interpreter,
and each output block is pasted verbatim.

New here? Start with [getting started](getting-started.md) and
[syntax basics](syntax-basics.md). For the one-page overview see the
[cheatsheet](cheatsheet.md); for *every* built-in see [builtins](builtins-reference.md).

## On this page

- [Writing text: literals & escapes](#writing-text-literals--escapes)
- [Joining text with `+`](#joining-text-with-)
- [How `+` turns other values into text](#how--turns-other-values-into-text)
- [f-strings: drop values straight in](#f-strings-drop-values-straight-in)
- [Character indexing `s[i]`](#character-indexing-si)
- [The text built-ins](#the-text-built-ins)
  - [Case: `upper`, `lower`, `title`](#case-upper-lower-title)
  - [`trim` — strip surrounding whitespace](#trim--strip-surrounding-whitespace)
  - [`replace` — swap every match](#replace--swap-every-match)
  - [`split` and `join`](#split-and-join)
  - [`words` and `lines`](#words-and-lines)
  - [Searching: `contains`, `starts_with`, `ends_with`, `index_of`, `count`](#searching-contains-starts_with-ends_with-index_of-count)
  - [`length` — count the characters](#length--count-the-characters)
  - [`slice` — a sub-string by position](#slice--a-sub-string-by-position)
  - [`number` — text into a number](#number--text-into-a-number)
- [A complete example](#a-complete-example)
- [Quick gotchas](#quick-gotchas)
- [Where to go next](#where-to-go-next)

---

## Writing text: literals & escapes

A text value (a "string") is written between **double quotes**. Single quotes are
not string quotes in Sprout — always use `"`.

Inside a string, a backslash starts an **escape**:

| Escape | Means |
| --- | --- |
| `\n` | a new line |
| `\t` | a tab |
| `\"` | a literal double quote |
| `\\` | a literal backslash |

```sprout
show "Hello, world"
show "Tab\there\nand a new line"
show "She said \"hi\""
show "back\\slash"
```

```text
Hello, world
Tab	here
and a new line
She said "hi"
back\slash
```

**Text is single-line.** A string literal can't span multiple lines in your
source file — the closing `"` has to be on the same line as the opening one. To
get a line break *inside* the text, use `\n` (as above). If you want a multi-line
block, build it with `\n` or join several strings together.

## Joining text with `+`

The `+` operator does double duty: it adds numbers, and it **glues text**
together. As long as one side is text, `+` joins.

```sprout
show "one" + " " + "two"
make greeting = "Hi"
make who = "Sam"
show greeting + ", " + who + "!"
```

```text
one two
Hi, Sam!
```

## How `+` turns other values into text

When you `+` a non-text value onto text, Sprout turns that value into text first
— the same way `show` would print it. This is the one set of rules to remember;
[f-strings](#f-strings-drop-values-straight-in) use exactly the same conversion.

| Value | Becomes the text |
| --- | --- |
| a number like `42` | `42` (whole numbers have no `.0`) |
| a number like `3.14` | `3.14` |
| `yes` / `no` | `yes` / `no` |
| `nothing` | `nothing` |
| a list `[1, 2, 3]` | `[1, 2, 3]` |
| a map `{a: 1, b: 2}` | `{a: 1, b: 2}` |

```sprout
show "n=" + 42
show "pi=" + 3.14
show "flag=" + yes + " / " + no
show "empty=" + nothing
show "list=" + [1, 2, 3]
show "map=" + {a: 1, b: 2}
```

```text
n=42
pi=3.14
flag=yes / no
empty=nothing
list=[1, 2, 3]
map={a: 1, b: 2}
```

> Numbers print as the shortest exact form: `42`, not `42.0`; `0.5`, not
> `0.500000`. There is only one number type (see [syntax basics](syntax-basics.md)).

## f-strings: drop values straight in

Building text with lots of `+` gets noisy. An **f-string** lets you put values
right inside the quotes. Put an `f` directly before the opening quote, and wrap
any expression in `{ }`:

```sprout
make name = "Sam"
make x = 5
make y = 10
show f"Hi {name}, {x + y} pts"
```

```text
Hi Sam, 15 pts
```

Anything that's a valid expression can go inside `{ }` — variables, arithmetic,
built-in calls, indexing, your own tasks:

```sprout
make name = "Sam"
make items = [1, 2, 3]
show f"{name} likes {length(name)}-letter names"
show f"items={items}, first={items[0]}"
```

```text
Sam likes 3-letter names
items=[1, 2, 3], first=1
```

The value inside `{ }` is converted to text by the **same rules as `+`** (see the
table above), so `yes`, `nothing`, lists and maps all look the same:

```sprout
make ok = yes
make z = nothing
show f"flag={ok} and missing={z}"
show f"price {3.5} half {1 / 2}"
```

```text
flag=yes and missing=nothing
price 3.5 half 0.5
```

**To show a literal brace**, escape it with a backslash: `\{` and `\}`. The same
`\n`, `\t`, `\"`, `\\` escapes work in f-strings too.

```sprout
make x = 5
make y = 10
show f"the set is \{x, y\} literally"
```

```text
the set is {x, y} literally
```

f-strings are just sugar for `+`-joining, so they work anywhere a string does —
including inside a [task](tasks-and-lambdas.md):

```sprout
task badge(label, n):
    give f"[{upper(label)}: {n}]"
show badge("score", 42)
```

```text
[SCORE: 42]
```

> An f-string also stays on **one line**, and an empty `{}` is an error — put a
> value inside, like `{name}`.

## Character indexing `s[i]`

Use `[ ]` to read a single character out of text by position. Positions are
**0-based**: the first character is `s[0]`.

Indexing is **UTF-8 aware** — it counts *characters*, not bytes — so `"café"[3]`
is `é` even though `é` takes two bytes under the hood. `length` counts the same
way, so the last character is always `s[length(s) - 1]`.

```sprout
make w = "hello"
show w[0]
show w[4]
show "café"[3]
show length("café")
```

```text
h
o
é
4
```

Asking for a position that doesn't exist raises an
[`index` error](errors.md) (catchable with [`try`/`caught`](errors.md)):

```sprout
make w = "hi"
show w[5]
```

```text
  Sprout error in your-file.sprout (line 2): that position doesn't exist in the text.
```

To walk a string character by character, loop over its length:

```sprout
make w = "abc"
for each i in range(length(w)):
    show f"{i}: {w[i]}"
```

```text
0: a
1: b
2: c
```

> `s[i]` gives back a *character* (a one-character string), not a code number.
> Sprout has no separate character type — a character is just text of length 1.

## The text built-ins

These are always available — no import, no setup. Call them like any function.
Below, each one has its signature, a runnable example, and the real output.

> Most of these expect **text** arguments; passing the wrong kind of value gives a
> friendly error (e.g. `upper/lower need text.`). `replace` and friends never
> change the original — they return a **new** string.

### Case: `upper`, `lower`, `title`

| Call | Does |
| --- | --- |
| `upper(t)` | every letter UPPERCASE |
| `lower(t)` | every letter lowercase |
| `title(t)` | Title Case — first letter of each word up, the rest down |

```sprout
show upper("hi there")
show lower("LOUD Voice")
show title("the QUICK brown fox")
```

```text
HI THERE
loud voice
The Quick Brown Fox
```

> Case-changing is ASCII: `A`–`Z` ↔ `a`–`z`. Accented letters like `é` are left
> as they are. `title` treats any run of spaces/tabs/newlines as a word break.

### `trim` — strip surrounding whitespace

`trim(t)` removes spaces, tabs, and newlines from **both ends** (not the middle).

```sprout
show trim("   spaced out   ")
```

```text
spaced out
```

### `replace` — swap every match

`replace(text, find, with)` returns a new string with **every** occurrence of
`find` swapped for `with`.

```sprout
show replace("a-b-c", "-", "+")
show replace("yes yes yes", "yes", "no")
```

```text
a+b+c
no no no
```

### `split` and `join`

`split(text, separator)` breaks text into a **list** of pieces. Splitting on the
empty string `""` gives one item per character.

`join(list, separator)` is the inverse: it glues a list back into text, putting
`separator` between items. Non-text items are converted with the usual
[stringify rules](#how--turns-other-values-into-text).

```sprout
show split("a,b,c", ",")
show split("hi", "")
show join([1, 2, 3], "-")
show join(["a", "b"], ", ")
```

```text
[a, b, c]
[h, i]
1-2-3
a, b
```

### `words` and `lines`

`words(text)` splits on whitespace and **collapses** runs of it — handy for
cleaning up messy input (no empty pieces, leading/trailing space ignored).

`lines(text)` splits on newlines. Blank lines in the middle are kept as `""`; a
trailing newline does **not** add an empty final line; `""` gives `[]`.

```sprout
show words("  the   quick brown  ")
show lines("a\nb\nc")
```

```text
[the, quick, brown]
[a, b, c]
```

### Searching: `contains`, `starts_with`, `ends_with`, `index_of`, `count`

| Call | Gives back |
| --- | --- |
| `contains(text, part)` | `yes`/`no` — is `part` somewhere inside? |
| `starts_with(text, part)` | `yes`/`no` — does it begin with `part`? |
| `ends_with(text, part)` | `yes`/`no` — does it end with `part`? |
| `index_of(text, part)` | the 0-based position of the first match, or `nothing` if not found |
| `count(text, part)` | how many (non-overlapping) times `part` appears |

```sprout
show contains("banana", "nan")
show starts_with("hello", "he")
show ends_with("hello", "lo")
show index_of("hello world", "world")
show index_of("hello", "z")
show count("banana", "a")
show count("aaaa", "aa")
```

```text
yes
yes
yes
6
nothing
3
2
```

> `index_of` returns `nothing` (not `-1`) when there's no match — check it with
> `when index_of(...) == nothing:` or the [`or else`](operators.md) operator.
> `count` counts **non-overlapping** matches, so `"aaaa"` has 2 of `"aa"`, not 3.
> `contains`, `index_of`, and `count` also work on **lists** — see [builtins](builtins-reference.md).

### `length` — count the characters

`length(text)` counts characters the UTF-8-aware way (it also works on lists and
maps).

```sprout
show length("café")
show length("")
```

```text
4
0
```

### `slice` — a sub-string by position

`slice(text, start, end)` returns the characters from `start` **(inclusive)** up
to `end` **(exclusive)** — the same convention as most languages. Positions are
0-based and counted by character, and an `end` past the end is **clamped**, so you
never get an error for over-reaching.

```sprout
show slice("hello world", 0, 5)
show slice("café", 1, 4)
show slice("hi", 0, 99)
```

```text
hello
afé
hi
```

> `slice` also works on lists. Positions must be whole numbers; a fractional
> position is an error.

### `number` — text into a number

`number(text)` parses text into a number. If the text isn't a clean number, it
gives back **`nothing`** — so you can detect bad input instead of crashing.
Surrounding spaces are fine; leading-and-trailing junk (like `"12px"`) is not.

```sprout
show number("42")
show number("3.14")
show number("  -7 ")
show number("nope")
show number("12px")
```

```text
42
3.14
-7
nothing
nothing
```

This pairs perfectly with [`ask`](builtins-reference.md) for reading numbers from a user:

```sprout
make typed = "  8 "
make n = number(typed) or else 0
show f"you gave {n}, doubled is {n * 2}"
```

```text
you gave 8, doubled is 16
```

> `number` only understands plain decimal numbers. It rejects hex (`0x1F`),
> infinities, and `nan` on purpose — those all come back as `nothing`.

## A complete example

A small program that cleans a messy list of names, then reports on each one —
using `split`, `trim`, `join`, `upper`, `lower`, `slice`, `length`, indexing, and
f-strings together. This is real, runnable Sprout and the output is verbatim:

```sprout
make raw = "  Ada, Grace , Alan,Linus  "
make names = []
for each piece in split(trim(raw), ","):
    add(names, trim(piece))

show f"found {length(names)} names: {join(names, ", ")}"
for each name in names:
    show f"{upper(name[0])}{lower(slice(name, 1, length(name)))} has {length(name)} letters"
```

```text
found 4 names: Ada, Grace, Alan, Linus
Ada has 3 letters
Grace has 5 letters
Alan has 4 letters
Linus has 5 letters
```

And a tiny "slugify" task, showing text built-ins composing with the
[pipe operator](operators.md) `|>`:

```sprout
task slug(t):
    give replace(trim(lower(t)), " ", "-")

show "My Blog Post!" |> slug
show f"slug is {slug("Hello There World")}"
```

```text
my-blog-post!
slug is hello-there-world
```

## Quick gotchas

- **Use double quotes.** `'x'` is not a string in Sprout.
- **Text is single-line.** Use `\n` for line breaks; you can't span source lines.
- **`+` needs text on one side to join.** `"a" + "b"` joins; `1 + 2` adds. Mixing
  text and a number joins (`"n=" + 42`); two numbers always add.
- **Indexing is 0-based and by character.** First char is `s[0]`, last is
  `s[length(s) - 1]`. Out-of-range is an [`index` error](errors.md).
- **`index_of` returns `nothing`, not `-1`,** when there's no match.
- **`slice` is end-exclusive and clamped.** `slice(s, 0, 5)` takes 5 characters;
  an `end` past the end just stops at the end.
- **`number` returns `nothing` on bad input** — guard it with `or else`.
- **Case changes are ASCII** — accented letters keep their case.

## Where to go next

- [Operators](operators.md) — `+`, comparisons, `|>`, `or else`, ranges
- [Builtins](builtins-reference.md) — the full reference for all 89 built-ins
- [Lists & maps](syntax-basics.md) — the collections text often turns into
- [Tasks & lambdas](tasks-and-lambdas.md) — wrap text logic in reusable tasks
- [Pattern matching](pattern-matching.md) — `match` on text and structure
- [Errors](errors.md) — catching `index` / `type` errors from bad text ops
- [Testing & learn mode](testing-and-learn.md) — `test`/`expect` your text code
- [Cheatsheet](cheatsheet.md) — the whole language on one page
