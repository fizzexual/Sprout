# Builtins reference (complete)

Every one of Sprout's **98 built-in functions**, with a signature, what it does,
whether it changes its input or returns a new value, a tiny example you can run
right now, its real output, and the error it raises on bad input. This is the
long one — bookmark it.

> **How to read each entry.** "**Mutate or return**" is the single most important
> thing about a builtin in Sprout. A *command* (like `add`) changes a list and
> hands back `nothing`. A *query* (like `sum`) reads its input and returns a new
> value, never touching the original. A few (`sort`, `reverse`, `sort_by`) do both
> — they change the list **in place** *and* return that same list so it reads
> nicely. When in doubt, this page says which.

For the friendly tour, see [Built-in functions](builtins-reference.md). For the rules these
errors follow, see [Errors & error handling](errors.md).

---

## Contents

- [How builtins behave (the three patterns)](#how-builtins-behave-the-three-patterns)
- [Numbers & math](#numbers--math) — `abs` `ceil` `floor` `round` `sqrt` `pow` `min` `max` `clamp` `sign` `sum` `sin` `cos` `tan` `exp` `log` `pi`
- [Random & time](#random--time) — `random` `seed` `now` `today` `wait` `time` `days` `hours` `minutes` `time_parts` `time_make` `time_format`
- [Conversion & inspection](#conversion--inspection) — `number` `is_number` `kind_of` `is_a` `json`
- [Text](#text) — `upper` `lower` `title` `trim` `replace` `split` `join` `words` `lines` `contains` `starts_with` `ends_with` `index_of` `count` `slice` `length` `pad_start` `pad_end` `code` `char`
- [Text patterns (regex)](#text-patterns-regex) — `matches` `find` `find_all` `captures`
- [Lists](#lists) — `add` `remove` `insert` `first` `last` `length` `sort` `sort_by` `reverse` `unique` `zip` `flatten` `range` `slice` `map` `filter` `reduce` `group_by` `min_by` `max_by` `partition` `chunk` `copy` `contains` `index_of` `count` `sum`
- [Maps](#maps) — `keys` `values` `contains` `remove` `length` `copy`
- [Input](#input) — `ask`
- [Files](#files) — `read` `write` `append` `exists`
- [Web](#web) — `get` `explore`
- [System](#system) — `system.run`
- [Environment & arguments](#environment--arguments) — `args` `env` `exit`
- [Persistence](#persistence) — `remember` `recall` `forget`
- [Output & colour](#output--colour) — `color` (and `show`)
- [The error a builtin raises](#the-error-a-builtin-raises)
- [Quick index of all 98](#quick-index-of-all-98)

---

## How builtins behave (the three patterns)

Three rules cover almost everything:

1. **Queries return a new value and never touch the input.** `sum`, `unique`,
   `slice`, `map`, `keys`, `upper`, `copy` — all of them. Your original list/map/text
   is exactly as it was.
2. **Commands change their first argument and return `nothing`.** `add` and
   `insert` grow a list; `write`/`append` change a file. The return value is
   `nothing` (they're for the side effect).
3. **`remove` returns what it removed**, and **`sort` / `reverse` / `sort_by`
   change the list in place *and* return that same list** (a reference, not a
   copy), so `show sort(xs)` prints the sorted list *and* leaves `xs` sorted.

`copy(x)` is the one query that exists *because* lists and maps are shared. See
[Lists & maps are shared](collections.md) for why that matters.

```sprout
make xs = [3, 1, 2]
show sort(xs)        ~ returns the list...
show xs              ~ ...and xs is sorted too (in place)
add(xs, 9)           ~ a command: returns nothing
show xs
```

```text
[1, 2, 3]
[1, 2, 3]
[1, 2, 3, 9]
```

---

## Numbers & math

All of these need **numbers** and raise a friendly `error` (kind `"error"`) if you
hand them something else. Numbers are IEEE-754 doubles — see the
[number rules](errors.md) for divide-by-zero and the rest.

### `abs(n)` → number

The size of a number, dropping any minus sign. **Returns** a new number.

```sprout
show abs(-7)
show abs(7)
```

```text
7
7
```

Bad input: `abs("x")` → `abs needs a number.`

### `ceil(n)` / `floor(n)` / `round(n [, places])` → number

Round **up** (`ceil`), **down** (`floor`), or to the **nearest** whole number
(`round`). `round` rounds a half **away from zero** (`2.5` → `3`, `-2.5` → `-3`).
Give `round` a second argument to round to that many **decimal places**
(`round(3.14159, 2)` → `3.14`). **Return** a new number.

```sprout
show ceil(2.1)
show floor(2.9)
show round(2.5)
show round(-2.5)
show round(3.14159, 2)
```

```text
3
2
3
-3
3.14
```

Bad input: `round needs a number, and optionally how many decimal places, like round(3.14159, 2).` (`ceil` / `floor` say `... needs a number.`)

### `sqrt(n)` → number

Square root. **Returns** a new number. A **negative** input raises kind `"math"`.

```sprout
show sqrt(16)
show sqrt(2)
```

```text
4
1.4142135623730951
```

Bad input: `sqrt("x")` → `sqrt needs a number.` · `sqrt(-4)` → `sqrt can't take a negative number.` (kind `"math"`).

### `pow(base, exponent)` → number

`base` raised to `exponent`. **Returns** a new number. (There is no `**` operator —
use `pow`.) Like `sqrt` and division, `pow` guards its domain: a result that
isn't a finite number (a negative base to a fractional power, a zero base to a
negative power, or an overflow) raises a clean `math` error rather than `nan`/`inf`.

```sprout
show pow(2, 10)
show pow(9, 0.5)
```

```text
1024
3
```

Bad input: `pow needs two numbers, like pow(2, 10).` · out of domain/overflow:
`pow can't compute that ...` (kind `math`).

### `min(...)` / `max(...)` → number

The smallest / largest of **one or more** numbers passed directly (not a list — for
a list, use `reduce` or sort). **Return** a number.

```sprout
show min(3, 9, 5)
show max(3, 9, 5)
show min(42)
```

```text
3
9
42
```

Bad input: no arguments → `min/max need at least one number.` · a non-number among them → `min/max work on numbers.` (kind `"type"`).

### `sum(list)` → number

Adds up a **list of numbers**. **Returns** a new number; the list is untouched. An
empty list is `0`.

```sprout
show sum([1, 2, 3, 4])
show sum([])
```

```text
10
0
```

Bad input: not a list → `sum needs a list of numbers, like sum([1, 2, 3]).` · a non-number item → `sum needs every item to be a number.` (kind `"type"`).

### `sin(x)` / `cos(x)` / `tan(x)` → number

Trigonometry. The angle `x` is in **radians** (use `pi()` to convert — a full turn is
`2 * pi()`). **Return** a new number.

```sprout
show round(sin(0))
show round(cos(0))
show round(sin(pi() / 2))   ~ sin(90°) = 1
```

```text
0
1
1
```

Bad input: `sin needs a number (an angle in radians).` (same shape for `cos` / `tan`).

### `exp(x)` → number

`e` raised to the power `x` (the inverse of `log`). **Returns** a new number.

```sprout
show round(exp(0))   ~ e^0 = 1
show round(exp(1))   ~ e ~ 2.718 -> 3
```

```text
1
3
```

Bad input: `exp needs a number.`

### `log(x)` / `log(x, base)` → number

The **natural** logarithm of `x` (base *e*), or the logarithm of `x` in an explicit `base`.
**Returns** a new number. `x` must be **positive**; a `base` must be positive and not `1`.

```sprout
show round(log(exp(1)))   ~ ln(e) = 1
show round(log(8, 2))     ~ log2(8) = 3
show round(log(1000, 10)) ~ 3
```

```text
1
3
3
```

Bad input: `log needs a number, and an optional base: log(x) or log(x, base).` ·
`log(0)` / `log(-1)` → `log needs a positive number.` (kind `"math"`) ·
`log(8, 1)` → `a logarithm base must be positive and not 1.` (kind `"math"`).

### `pi()` → number

The constant π ≈ `3.141592653589793`. Takes no inputs. **Returns** a new number.

```sprout
show round(pi() * 100) / 100
```

```text
3.14
```

Bad input: `pi takes no inputs, like pi().`

### `clamp(x, low, high)` → number

Keep `x` inside the range `low..high`: returns `low` if `x` is below it, `high` if
above, otherwise `x` unchanged. **Returns** a new number.

```sprout
show clamp(15, 0, 10)
show clamp(-3, 0, 10)
show clamp(5, 0, 10)
```

```text
10
0
5
```

Bad input: `clamp needs three numbers: clamp(x, low, high).`

### `sign(x)` → number

The sign of `x`: `-1` if negative, `1` if positive, `0` if zero. **Returns** a new number.

```sprout
show sign(-7)
show sign(0)
show sign(42)
```

```text
-1
0
1
```

Bad input: `sign needs a number.`

---

## Random & time

### `random()` / `random(n)` / `random(a, b)` → number

- `random()` — a fraction `0 ≤ r < 1`.
- `random(n)` — a whole number `0 … n-1` (and `0` if `n ≤ 0`).
- `random(a, b)` — a whole number from `a` to `b` **inclusive** (it swaps them if `a > b`).

**Returns** a new number. Seed it with `seed` to make a run reproducible.

```sprout
seed(123)
show random(1000000)
seed(123)
show random(1000000)
```

```text
440
440
```

(Same seed → same sequence; that's how the example is reproducible here.) Bad
input: `random() gives 0..1; random(n) or random(a,b) give whole numbers.`

### `seed(n)` → nothing

Sets the seed for `random` so the next calls are reproducible. **Returns** `nothing`
(it's a command). Without a `seed`, runs aren't reproducible.

```sprout
seed(42)
show random(6)
```

```text
1
```

Bad input: `seed needs a number, like seed(42).`

### `now()` / `today()` → text

The current local **date + time** (`now`) or just the **date** (`today`), as text in
`YYYY-MM-DD HH:MM:SS` / `YYYY-MM-DD` form. **Return** new text. (Output varies by
clock — the example shows the *shape*.)

```sprout
show length(today())   ~ "2026-06-16" is 10 characters
show length(now())     ~ "2026-06-16 14:30:00" is 19
show kind_of(today())
```

```text
10
19
text
```

These take no arguments.

### `wait(seconds)` → nothing

Pause for `seconds` (a fraction is fine). **Returns** `nothing`. Sprout is
single-threaded, so this blocks the whole program.

```sprout
show "start"
wait(0)
show "done"
```

```text
start
done
```

Bad input: `wait needs a number of seconds.`

### `time()` → number

The current moment as a **number**: seconds since 1970 (the Unix epoch). Because it's just a
number, you can do maths on it — add `days(7)`, subtract two moments to get the seconds
between them. (`now()` is the same instant as readable *text*; `time()` is the one you compute
with.) **Returns** a new number. Takes no inputs.

```sprout
make a = time()
wait(0)
show time() - a >= 0     ~ time never goes backwards
```

```text
yes
```

### `days(n)` / `hours(n)` / `minutes(n)` → number

The number of **seconds** in `n` days / hours / minutes — so date maths reads naturally.
**Return** a new number.

```sprout
show days(1)
show hours(2)
show minutes(30)
```

```text
86400
7200
1800
```

### `time_parts(timestamp)` → map

Breaks a timestamp into a map with `year`, `month` (1–12), `day`, `hour`, `minute`, `second`,
and `weekday` (a name like `"Friday"`), in **local** time. **Returns** a new map.

```sprout
make p = time_parts(time_make(2026, 6, 19, 14, 30, 0))
show p["year"], p["month"], p["day"]
show p["weekday"]
```

```text
2026 6 19
Friday
```

Bad input: `time_parts needs a timestamp (a number from time()), like time_parts(time()).`

### `time_make(year, month, day [, hour, minute, second])` → number

Builds a timestamp from calendar parts (local time); hour/minute/second default to `0`.
Out-of-range parts **normalise** (month `13` rolls into next January), which makes "30 days
from now" easy. **Returns** a new number.

```sprout
make xmas = time_make(2026, 12, 25)
make today = time_make(2026, 6, 19)
show round((xmas - today) / days(1))    ~ days until Christmas
```

```text
189
```

Bad input: `time_make needs year, month, day (and optionally hour, minute, second).`

### `time_format(timestamp)` → text

A timestamp as readable text, `YYYY-MM-DD HH:MM:SS`, in local time. **Returns** new text.

```sprout
show time_format(time_make(2026, 6, 19, 9, 5, 0))
```

```text
2026-06-19 09:05:00
```

Bad input: `time_format needs a timestamp (a number from time()), like time_format(time()).`

---

## Conversion & inspection

### `number(text)` → number or nothing

Turns text into a number. **Returns** a new number, or **`nothing`** if the text
isn't a number (it never errors) — so it's safe on user input. It rejects hex,
`inf`, and `nan`; surrounding spaces are fine.

```sprout
show number("42")
show number("  -3.14  ")
show number("abc")
show number("0x1F")
make port = number("nope") or else 8080
show port
```

```text
42
-3.14
nothing
nothing
8080
```

The `or else` idiom is the standard way to supply a default — see
[operators](operators.md). Bad input: only the wrong **count** errors (`number needs one input.`); a non-number value just returns `nothing`.

### `is_number(text)` → yes/no

`yes` if `number(text)` would succeed, `no` otherwise — a check that doesn't
convert. Handy for validating input before you use it.

```sprout
show is_number("3.14")
show is_number("-5")
show is_number("12abc")
```

```text
yes
yes
no
```

Bad input: `is_number needs one input.`

### `kind_of(x)` → text

A value's type as text — one of `"number"`, `"text"`, `"yes-no"`, `"nothing"`,
`"list"`, `"map"`, `"task"` — or, for an **object** (an instance of a [`type`](types-and-objects.md)),
the type's own name (e.g. `"Point"`). **Returns** new text. Perfect for branching on a type.

```sprout
show kind_of(42)
show kind_of("hi")
show kind_of(yes)
show kind_of(nothing)
show kind_of([1, 2])
show kind_of({a: 1})
```

```text
number
text
yes-no
nothing
list
map
```

Bad input: `kind_of needs one value, like kind_of(x).`

### `is_a(value, "TypeName")` → yes/no

Is `value` an object of that [type](types-and-objects.md), or of a type that **inherits** from
it? (Like Java's `instanceof`.) Non-objects are always `no`. **Returns** `yes`/`no`.

```sprout
type Animal:
    make name
type Dog from Animal:
    make breed

make d = Dog("Rex", "Lab")
show is_a(d, "Dog")       ~ yes
show is_a(d, "Animal")    ~ yes  (an ancestor)
show is_a(d, "Cat")       ~ no
show is_a(42, "Animal")   ~ no
```

Bad input: `is_a needs a value and a type name, like is_a(d, "Animal").`

### `json(text)` → any

Parses JSON text into native Sprout values: objects become **maps**, arrays become
**lists**, `true`/`false` become `yes`/`no`, `null` becomes `nothing`. **Returns** a
fresh value. Pair it with [`get`](#web) to consume an API with no libraries.

```sprout
make data = json("{\"name\": \"Sam\", \"pets\": [\"cat\", \"dog\"]}")
show data["name"]
show data["pets"][0]
show json("[1, 2, 3]")
```

```text
Sam
cat
[1, 2, 3]
```

Bad input: `json needs some text to read.` (Malformed JSON parses as far as it can
rather than crashing.)

---

## Text

Text is **UTF-8** and immutable; every text builtin returns **new** text (or a
list/number) and never changes its input. Indexes are **character** positions, not
bytes (`"café"` has length `4`).

### `upper(t)` / `lower(t)` → text

Change case (ASCII letters). **Return** new text.

```sprout
show upper("hi there")
show lower("HI THERE")
```

```text
HI THERE
hi there
```

Bad input: `upper/lower need text.`

### `title(t)` → text

Title Case — the first letter of each word uppercased, the rest lowercased (ASCII).
**Returns** new text.

```sprout
show title("the QUICK brown fox")
```

```text
The Quick Brown Fox
```

Bad input: `title needs text.`

### `trim(t)` → text

Remove leading and trailing whitespace (spaces, tabs, newlines). **Returns** new
text.

```sprout
show "[" + trim("   x   ") + "]"
```

```text
[x]
```

Bad input: `trim needs text.`

### `replace(text, find, with)` → text

Swap **every** occurrence of `find` with `with`. **Returns** new text.

```sprout
show replace("a-b-c", "-", "+")
```

```text
a+b+c
```

Bad input: `replace needs three pieces of text: replace(text, find, with).`

### `split(text, sep)` → list

Break text into a list on each `sep`. An **empty separator** splits into individual
characters. **Returns** a new list.

```sprout
show split("a,b,c", ",")
show split("abc", "")
```

```text
[a, b, c]
[a, b, c]
```

Bad input: `split needs text and a separator.`

### `join(list, sep)` → text

Glue a list into text with `sep` between items (each item is shown in its display
form). **Returns** new text. The inverse of `split`.

```sprout
show join([1, 2, 3], "-")
show join(["a", "b"], ", ")
```

```text
1-2-3
a, b
```

Bad input: `join needs a list and a separator.`

### `words(t)` → list

Split on any **run of whitespace**, dropping the gaps (so leading/trailing/multiple
spaces never make empty items). **Returns** a new list.

```sprout
show words("  the   quick brown  ")
```

```text
[the, quick, brown]
```

Bad input: `words needs text.`

### `lines(t)` → list

Split on newlines. A **trailing** newline does **not** add a final empty line, and
`""` gives `[]` (but blank lines in the middle are kept). **Returns** a new list.

```sprout
show lines("a\nb\nc")
show lines("a\n\nb")
show length(lines("a\nb\n"))
```

```text
[a, b, c]
[a, , b]
2
```

Bad input: `lines needs text.`

### `contains(text, piece)` → yes/no

Is `piece` a substring of `text`? **Returns** `yes` / `no`. (`contains` also works on
[lists](#lists) and [maps](#maps) — see those sections.)

```sprout
show contains("hello world", "world")
show contains("hello", "z")
```

```text
yes
no
```

Bad input: `contains works on a list, a map, or text.`

### `starts_with(t, prefix)` / `ends_with(t, suffix)` → yes/no

Does the text begin / end with the given piece? **Return** `yes` / `no`.

```sprout
show starts_with("hello", "he")
show ends_with("hello", "lo")
show starts_with("hello", "xy")
```

```text
yes
yes
no
```

Bad input: `starts_with needs two pieces of text.` (same shape for `ends_with`).

### `index_of(text, piece)` → number or nothing

The **character** position of the first occurrence of `piece`, or **`nothing`** if
it isn't found. **Returns** a number or `nothing`. (Also works on [lists](#lists).)

```sprout
show index_of("banana", "nan")
show index_of("banana", "z")
```

```text
2
nothing
```

Bad input: `index_of works on a list, or on text + text.`

### `count(text, piece)` → number

How many **non-overlapping** times `piece` appears. **Returns** a number. (Also works
on [lists](#lists).)

```sprout
show count("banana", "a")
show count("aaaa", "aa")
```

```text
3
2
```

Bad input: `count works on a list (+ a value) or text (+ text).`

### `slice(text, start, end)` → text

A substring from `start` (**inclusive**) to `end` (**exclusive**), by character,
clamped to the ends. **Returns** new text. (Also works on [lists](#lists).)

```sprout
show slice("hello world", 0, 5)
show slice("café", 1, 4)
```

```text
hello
afé
```

Bad input: non-whole positions → `slice positions must be whole numbers.` · wrong shape → `slice needs a list-or-text and two whole-number positions, like slice(xs, 1, 3).`

### `length(t)` → number

How many **characters** (UTF-8 aware). **Returns** a number. (Also counts list/map
items — see [Lists](#lists).)

```sprout
show length("café")
show length("")
```

```text
4
0
```

### `pad_start(text, width [, fill])` / `pad_end(text, width [, fill])` → text

Pad `text` to at least `width` characters by adding a fill (a space by default) on
the **start** (right-align) or the **end** (left-align). Text already that wide is
returned unchanged. **Return** a new string.

```sprout
show pad_start("7", 3, "0")
show pad_end("hi", 5) + "|"
```

```text
007
hi   |
```

Bad input: `pad_start/pad_end need text, a width, and an optional fill: pad_start("7", 3, "0").` · the width must be a whole number from 0 to 100000000.

### `code(char)` → number

The byte value of the **first** character of the text (`"A"` → `65`). **Returns** a
new number — the inverse of `char`.

```sprout
show code("A")
show code("hello")
```

```text
65
104
```

Bad input: `code needs one piece of text, like code("A").` · empty text errors (kind `value`).

### `char(number)` → text

A one-character string from a byte value **1–255** (`65` → `"A"`). **Returns** a new
string — the inverse of `code`. (Zero is rejected: Sprout text can't hold a NUL byte.)

```sprout
show char(65)
show char(97)
```

```text
A
a
```

Bad input: `char needs a number from 1 to 255 (Sprout text can't hold a zero byte).`

---

## Text patterns (regex)

Three functions match a **regular expression** against text. A pattern is itself text, so a
shorthand that starts with a backslash is written with **two** backslashes (`"\\d"`) — a
backslash escapes a backslash, exactly like Java or JavaScript. Character classes like `[0-9]`
need no escaping and are often clearer.

### `matches(text, pattern)` → yes/no

Does the **whole** `text` match `pattern`? **Returns** `yes`/`no`.

```sprout
show matches("2026-06-19", "[0-9]{4}-[0-9]{2}-[0-9]{2}")
show matches("hello world", "[a-z]+")          ~ no: the space breaks a full match
show matches("a_b9", "\\w+")
```

```text
yes
no
yes
```

### `find(text, pattern)` → text or nothing

The **first** substring of `text` that matches `pattern`, scanning left to right — or
`nothing` if there's no match. **Returns** new text.

```sprout
show find("order 42 then 99", "[0-9]+")        ~ 42
show find("phone 555-1234", "\\d{3}-\\d{4}")   ~ 555-1234
show find("nothing here", "[0-9]+")            ~ nothing
```

### `find_all(text, pattern)` → list

**Every** non-overlapping match, left to right, as a list of text (empty if none).
**Returns** a new list.

```sprout
show find_all("a1 b2 c3", "[0-9]")
show find_all("cat hat bat", "[a-z]at")
```

```text
[1, 2, 3]
[cat, hat, bat]
```

Bad input (all three): the text and pattern must both be text — e.g.
`find needs text and a pattern, like find(s, "[0-9]+").`

### `captures(text, pattern)` → list or nothing

The first match as a list: element `0` is the whole match, then one element per
**capture group** `( … )` in order (a group that didn't take part is `nothing`).
**`nothing`** if the pattern doesn't match. This is how you pull fields out of text.

```sprout
make c = captures("2026-06-23", "([0-9]+)-([0-9]+)-([0-9]+)")
show c[1], "/", c[2], "/", c[3]
show captures("nope", "([0-9]+)")
```

```text
2026 / 06 / 23
nothing
```

Bad input: `captures needs text and a pattern, like captures(s, "([0-9]+)-([0-9]+)").`

### Pattern syntax

| Write | Matches |
| --- | --- |
| `abc` | the literal characters `a`, `b`, `c` |
| `.` | any one character (except a newline) |
| `^` … `$` | the start / end of the text |
| `[abc]` `[a-z]` | one character in the set / range |
| `[^abc]` | one character **not** in the set |
| `\\d` `\\w` `\\s` | a digit / word char (`[A-Za-z0-9_]`) / whitespace |
| `\\D` `\\W` `\\S` | the negation of each |
| `\\.` `\\\\` | a literal `.`, `\`, and so on |
| `x*` `x+` `x?` | zero-or-more / one-or-more / optional (greedy) |
| `x{3}` `x{2,}` `x{2,5}` | exactly / at least / between *n* and *m* times |
| `( … )` | a **capture group** (read it back with `captures`); also groups for a quantifier, e.g. `(ab)+` |
| `a|b` | **alternation** — match `a` or `b` (lowest precedence, so `ab|cd` is `(ab)|(cd)`) |

A built-in step limit means even a pathological pattern returns quickly instead of hanging.

---

## Lists

Positions are **0-based**. Lists are **shared references** — see
[Collections](collections.md). The commands below change the list you pass in.

### `length(list)` → number

How many items. **Returns** a number; the list is untouched.

```sprout
show length([10, 20, 30])
```

```text
3
```

Bad input: `length needs one thing.` · (a value that isn't a list/map/text) `length works on a list, a map, or text.`

### `add(list, value)` → nothing

Append `value` to the **end**. **Mutates** the list, **returns `nothing`**. (This is
the list "append" — the function literally named `append` is a *file* op; see
[Files](#files).)

```sprout
make xs = [1, 2]
add(xs, 3)
show xs
```

```text
[1, 2, 3]
```

Bad input: `add needs a list and a value, like add(things, 5).` · first arg not a list → `add's first input must be a list.`

### `insert(list, position, value)` → nothing

Insert `value` at `position`, shifting the rest right. `position` may be `0 … length`
(inserting at `length` appends). **Mutates** the list, **returns `nothing`**.

```sprout
make xs = [10, 20, 30]
insert(xs, 1, 99)
show xs
```

```text
[10, 99, 20, 30]
```

Bad input: wrong shape → `insert needs a list, a position, and a value.` · non-whole position → `insert needs a whole-number position.` · out of range → `that insert position is out of range (0 to the list's length).` (kind `"index"`).

### `remove(list, position)` → the removed item

Remove the item at `position` and **return it** (a pop). **Mutates** the list.
(On a [map](#maps), `remove(map, key)` removes by key.)

```sprout
make xs = [10, 20, 30]
make gone = remove(xs, 1)
show gone
show xs
```

```text
20
[10, 30]
```

Bad input: out-of-range position → `that position doesn't exist in the list.` (kind `"index"`) · non-whole position → `to remove from a list, give a whole-number position.`

### `first(list)` / `last(list)` → the end item

The first / last item. **Return** the item (a reference, not a copy). These
**error** on an empty list (on purpose — so beginners see why).

```sprout
make xs = [10, 20, 30]
show first(xs), last(xs)
```

```text
10 30
```

Bad input: `first needs a list.` · on `[]` → `first() needs a list with at least one item (this list is empty).`

### `sort(list)` → the same list, sorted

Sort a list of **all numbers** or **all text**, ascending, **in place**, and
**return that same list**. (For records, use `sort_by`.)

```sprout
make xs = [3, 1, 2]
show sort(xs)
show sort(["pear", "apple", "fig"])
show xs
```

```text
[1, 2, 3]
[apple, fig, pear]
[1, 2, 3]
```

Bad input: not a list → `sort needs a list.` · a non-number/non-text item, or mixed kinds → `sort needs every item to be the same kind (all numbers, or all text).` (kind `"type"`).

### `sort_by(list, task)` → the same list, sorted

Sort **anything** by the value a task returns for each item — a number or text,
ascending, **stable** (equal keys keep their order), **in place**. **Returns** the
same list. Wrap in `reverse` for high-to-low.

```sprout
make people = [{n: "Ada", age: 36}, {n: "Mo", age: 17}, {n: "Sam", age: 52}]
make by_age = sort_by(people, task(p): p["age"])
show map(by_age, task(p): p["n"])
show reverse(sort_by(people, task(p): p["age"]))[0]["n"]
```

```text
[Mo, Ada, Sam]
Sam
```

Bad input: wrong shape → `sort_by needs a list and a task that gives the value to sort by, like sort_by(people, get_score).` · the task returns a non-number/non-text, or mixed kinds → `sort_by's task must give a number or text to sort by.` / `... the same kind of value for every item.` (kind `"type"`).

### `reverse(list)` → the same list, reversed

Reverse a list **in place** and **return** it.

```sprout
make xs = [1, 2, 3]
show reverse(xs)
show xs
```

```text
[3, 2, 1]
[3, 2, 1]
```

Bad input: `reverse needs a list.`

### `unique(list)` → new list

A **new** list with duplicates dropped, keeping the **first** occurrence's order.
The input is untouched.

```sprout
show unique([1, 1, 2, 3, 3, 1])
show unique(["b", "a", "b", "c"])
```

```text
[1, 2, 3]
[b, a, c]
```

Bad input: `unique needs a list.`

### `zip(a, b)` → new list of pairs

Pair up two lists into a list of 2-item lists, stopping at the **shorter** one.
**Returns** a new list.

```sprout
show zip(["a", "b", "c"], [1, 2])
```

```text
[[a, 1], [b, 2]]
```

Bad input: `zip needs two lists, like zip(names, scores).`

### `flatten(list)` → new list

Flatten **one level** — a list inside the list is spread out; non-lists pass through
unchanged. **Returns** a new list.

```sprout
show flatten([[1, 2], [3], [4, 5]])
show flatten([1, [2, 3], [[4]]])
```

```text
[1, 2, 3, 4, 5]
[1, 2, 3, [4]]
```

Bad input: `flatten needs a list.`

### `range(n)` / `range(a, b)` → new list

`0 … n-1`, or `a … b-1` — the **end is exclusive** (the 0-based sibling of the
inclusive `a to b` range). **Returns** a new list.

```sprout
show range(5)
show range(2, 6)
show 1 to 5
```

```text
[0, 1, 2, 3, 4]
[2, 3, 4, 5]
[1, 2, 3, 4, 5]
```

Bad input: `range needs 1 or 2 numbers, like range(5) or range(2, 8).` · an enormous span → `that range is too big.`

### `slice(list, start, end)` → new list

A sub-list from `start` (**inclusive**) to `end` (**exclusive**), clamped.
**Returns** a new list; the input is untouched. (Also works on [text](#text).)

```sprout
show slice([10, 20, 30, 40, 50], 1, 3)
show slice([1, 2, 3], 1, 99)
```

```text
[20, 30]
[2, 3]
```

Bad input: same messages as text `slice` above.

### `map(list, task)` → new list

Run `task` on each item and collect the results into a **new** list. The input is
untouched. The task takes one argument. (Use a lambda or a named task — see
[tasks & lambdas](tasks-and-lambdas.md).)

```sprout
show map([1, 2, 3], task(n): n * 2)
```

```text
[2, 4, 6]
```

Bad input: `map needs a list and a task, like map(names, shout).`

### `filter(list, task)` → new list

Keep the items for which `task` returns a truthy value. **Returns** a new list.

```sprout
show filter([1, 2, 3, 4, 5, 6], task(n): n % 2 == 0)
```

```text
[2, 4, 6]
```

Bad input: `filter needs a list and a task that gives yes/no, like filter(nums, is_even).`

### `reduce(list, task, start)` → any

Fold a list to a single value. The task takes `(total, item)` and returns the new
total, beginning from `start`. **Returns** the final value.

```sprout
show reduce([1, 2, 3, 4], task(total, item): total + item, 0)
show reduce(["a", "b", "c"], task(acc, s): acc + s, "")
```

```text
10
abc
```

Bad input: `reduce needs a list, a task taking (total, item), and a starting value, like reduce(nums, add_up, 0).`

### `group_by(list, task)` → map

Buckets the items into a map. The task returns each item's **key**; items with the same key
end up in a list under it (used as text, so any key works). Keeps insertion order. **Returns**
a new map.

```sprout
make people = [{name: "Ada", city: "London"}, {name: "Bo", city: "Paris"}, {name: "Cy", city: "London"}]
make g = group_by(people, task(p): p["city"])
show keys(g)
show map(g["London"], task(p): p["name"])
```

```text
[London, Paris]
[Ada, Cy]
```

Bad input: `group_by needs a list and a task that gives each item's key, like group_by(people, get_city).`

### `min_by(list, task)` / `max_by(list, task)` → an item or nothing

The **item** whose key (from the task) is smallest / largest. The key may be a number or text.
`nothing` for an empty list. **Returns** one of the list's items.

```sprout
make products = [{n: "pen", p: 3}, {n: "mug", p: 9}, {n: "cap", p: 5}]
show min_by(products, task(x): x["p"])["n"]   ~ cheapest
show max_by(products, task(x): x["p"])["n"]   ~ dearest
```

```text
pen
mug
```

Bad input: `min_by/max_by need a list and a task that gives a number or text key, like min_by(people, get_age).`

### `partition(list, task)` → [matches, rest]

Splits a list in two by a yes/no task: a list of **two lists**, the items that passed and the
items that didn't. **Returns** a new list.

```sprout
make r = partition([1, 2, 3, 4, 5, 6], task(n): n % 2 == 0)
show r[0]
show r[1]
```

```text
[2, 4, 6]
[1, 3, 5]
```

Bad input: `partition needs a list and a task that gives yes/no, like partition(nums, is_even).`

### `chunk(list, size)` → list of lists

Splits a list into consecutive pieces of at most `size` items (the last may be shorter).
**Returns** a new list of lists.

```sprout
show chunk([1, 2, 3, 4, 5, 6, 7], 3)
```

```text
[[1, 2, 3], [4, 5, 6], [7]]
```

Bad input: `chunk needs a list and a size, like chunk(items, 3).` · a size below 1 → `chunk needs a size of at least 1.`

### `copy(x)` → new value

A **deep** copy of any value. **Returns** the copy. The only way to get an
independent snapshot of a list/map (which are otherwise shared references).

```sprout
make a = [1, 2, 3]
make b = copy(a)
add(b, 99)
show a
show b
```

```text
[1, 2, 3]
[1, 2, 3, 99]
```

Bad input: `copy needs one value, like copy(myList).`

### `contains` / `index_of` / `count` on lists

The same three functions from [Text](#text) also work on lists, comparing by
**value**:

```sprout
show contains([1, 2, 3], 2)
show index_of([10, 20, 30], 20)
show count([1, 2, 2, 3, 2], 2)
```

```text
yes
1
3
```

`index_of` returns `nothing` when the value isn't present.

---

## Maps

Maps pair text keys with values, in **insertion order**. Looking up a missing key
gives `nothing` (it doesn't error) — use `m[key]` to read.

### `keys(map)` → new list

A list of the map's keys, in insertion order. **Returns** a new list.

```sprout
make person = {name: "Sam", age: 3}
show keys(person)
```

```text
[name, age]
```

Bad input: `keys needs a map.`

### `values(map)` → new list

A list of the map's values, in insertion order. **Returns** a new list.

```sprout
make person = {name: "Sam", age: 3}
show values(person)
```

```text
[Sam, 3]
```

Bad input: `values needs a map.`

### `contains(map, key)` → yes/no

Does the map have that **key**? **Returns** `yes` / `no`.

```sprout
make person = {name: "Sam"}
show contains(person, "name")
show contains(person, "age")
```

```text
yes
no
```

### `remove(map, key)` → the removed value

Remove a key and **return its value** (or `nothing` if the key was absent).
**Mutates** the map.

```sprout
make person = {name: "Sam", age: 3}
make gone = remove(person, "age")
show gone
show person
```

```text
3
{name: Sam}
```

Bad input: a non-text key → `a map key must be text.` (kind `"type"`).

### `length(map)` / `copy(map)`

`length(map)` is the number of keys; `copy(map)` is a deep, independent copy — both
behave exactly as in [Lists](#lists).

```sprout
make m = {a: 1, b: 2}
show length(m)
make c = copy(m)
set c["c"] = 3
show keys(m)
show keys(c)
```

```text
2
[a, b]
[a, b, c]
```

> New map keys are added with **`set`**, not `make` (`set m["c"] = 3`) — the map
> already exists, you're changing it.

---

## Input

### `ask(prompt)` → text

Print `prompt` (if given), then read one line from the user and **return** it as
text (the trailing newline trimmed). Returns `nothing` at end of input. Wrap with
`number(...)` for numeric input.

```sprout
make name = ask("What's your name? ")
show "Hi, " + name
make age = number(ask("Age? ")) or else 0
show age
```

```text
What's your name? Sam
Hi, Sam
Age? 30
30
```

(In an interactive terminal you type `Sam` then `30` at the prompts, and the terminal
echoes them as shown.) `ask()` with no prompt just reads a line.

---

## Files

File paths are relative to the **current folder**. These are turned **off in
[sandbox](sandbox-and-playground.md) mode**.

### `read(file)` → text or nothing

The whole file's contents as text, or **`nothing`** if it can't be read (e.g.
missing) — it doesn't error on a missing file. **Returns** text or `nothing`.

```sprout
write("notes.txt", "remember the milk")
show read("notes.txt")
show read("does-not-exist.txt")
```

```text
remember the milk
nothing
```

Bad input: `read needs a file name.`

### `write(file, text)` → nothing

Write `text` to `file`, **replacing** what was there (creating it if needed). The
value is shown in its display form, so you can write any value. **Returns** `nothing`.

```sprout
write("out.txt", "line one")
show read("out.txt")
```

```text
line one
```

Bad input: wrong shape → `write/append need a file name and some text.` · can't open for writing → `I couldn't open that file to write.` (kind `"io"`).

### `append(file, text)` → nothing

Like `write`, but **adds to the end** of the file instead of replacing it. **Returns**
`nothing`. **This is the file `append`** — to add to a *list*, use [`add`](#lists),
not `append`.

```sprout
write("log.txt", "first")
append("log.txt", "\nsecond")
show read("log.txt")
```

```text
first
second
```

Bad input: same messages as `write`. (Calling `append(list, x)` hits this file
path and errors with `write/append need a file name and some text.` — use `add`.)

### `exists(file)` → yes/no

Is there a readable file at that path? **Returns** `yes` / `no`.

```sprout
write("here.txt", "x")
show exists("here.txt")
show exists("nope.txt")
```

```text
yes
no
```

Bad input: `exists needs a file name.`

---

## Web

`get` and `explore` are turned **off in sandbox mode** (network access).


### `get(url)` → text or nothing

Fetch a URL and **return** the response body as text, or **`nothing`** on failure.
Pair with [`json`](#conversion--inspection) to consume an API.

```sprout
make body = get("https://api.github.com/repos/fizzexual/Sprout")
when body == nothing:
    show "no network"
otherwise:
    make repo = json(body)
    show repo["name"]
```

```text
Sprout
```

(Requires a network connection; offline it prints `no network`.) Bad input: `get needs a web address, like get("https://...").`

### `explore(value)` → new list

Flatten any value into a list of `path = value` strings — point it at a parsed API
response to *see every field and where it lives*. If you hand it a **string**, it's
parsed as JSON first. **Returns** a new list.

```sprout
make data = json("{\"name\": \"Sam\", \"pets\": [\"cat\", \"dog\"]}")
for each field in explore(data):
    show field
```

```text
name = Sam
pets[0] = cat
pets[1] = dog
```

Bad input: `explore needs one thing, like explore(json(get(url))).`

> `json` is listed under [Conversion & inspection](#conversion--inspection) because
> it also reads plain JSON text, but it's the other half of the web trio:
> `json(get(url))`.

---

## System

Shell access lives in the **`system` module** so it's explicit — you must
`use system` first. It is turned **off in sandbox mode**.

### `system.run(command)` → text or nothing

Run a shell command and **return** its captured output as text (or `nothing` on
failure). **Returns** text. This is the only member of the `system` module.

```sprout
use system
show trim(system.run("echo hello from the shell"))
```

```text
hello from the shell
```

Bad input: wrong shape → `system.run needs one piece of text, like system.run("echo hi").` · a non-text argument → `system.run needs text (the command to run).` · calling bare `run(...)` → `run now lives in the system module.` (with a hint to `use system`).

---

## Environment & arguments

### `args()` → list

The command-line arguments passed to your program, as a list of text — everything after the
script name in `sprout run app.sprout these are args`. Empty when there are none. **Returns** a
new list.

```sprout
~ run as:  sprout run greet.sprout Ada Grace
for each who in args():
    show "hello " + who
```

```text
hello Ada
hello Grace
```

Takes no inputs: `args takes no inputs, like args().`

### `env(name)` / `env(name, default)` → text or nothing

Reads an environment variable. **Returns** its value as text, or `nothing` if it isn't set —
or the `default` you pass. **Off in `--sandbox`** (environment variables can hold secrets).

```sprout
make port = env("PORT", "8080")
show "starting on port " + port
when env("DEBUG") != nothing:
    show "debug mode is on"
```

Bad input: `env needs a name, and an optional default: env("HOME") or env("PORT", "8080").`

### `exit([code])` → never returns

Ends the program immediately with an exit code (`0` by default) — handy for a CLI
tool that wants to stop with success or failure.

```sprout
when not exists("config.txt"):
    show "no config found"
    exit(1)
show "config is here"
```

Bad input: `exit takes an optional exit code, like exit(0) or exit(1).`

---

## Persistence

A tiny key/value store that survives between runs — one `sprout.data.json` file in
the current folder. Turned **off in sandbox mode**. See the
[language reference](errors.md) for the full round-trip rules.

### `remember(name, value)` → nothing

Save `value` under the text `name`. Any value round-trips except tasks. **Returns**
`nothing`.

```sprout
remember("score", 42)
show recall("score")
```

```text
42
```

Bad input: `remember needs a name (text) and a value, like remember("score", 10).` · can't save → `I couldn't save to the data file (sprout.data.json).` (kind `"io"`).

### `recall(name)` → any

Read back a remembered value, or **`nothing`** if it was never set (or was
forgotten). The result is an **independent copy** — mutating it doesn't change the
store. **Returns** the value or `nothing`.

```sprout
remember("score", 42)
show recall("score")
show recall("never_set")
make lives = recall("lives") or else 3
show lives
```

```text
42
nothing
3
```

Bad input: `recall needs a name (text), like recall("score").`

### `forget(name)` → yes/no

Delete a remembered name. **Returns** `yes` if it existed, `no` if not. **Mutates**
the store.

```sprout
remember("score", 42)
show forget("score")
show forget("score")
show recall("score")
```

```text
yes
no
nothing
```

Bad input: `forget needs a name (text), like forget("score").`

---

## Output & colour

### `color(name, text)` → text

Wrap `text` in a terminal colour and **return** the wrapped text (it inserts ANSI
escape codes; `show` it to see the colour). **Returns** new text — it doesn't print
on its own.

Colours: `red` `green` `yellow` `blue` `magenta` (`purple`) `cyan` `white` `gray`
(`grey`); styles: `bold` `dim`.

```sprout
show color("green", "done!")
show color("red", "error")
```

```text
done!
error
```

(In a real terminal "done!" is green and "error" is red — the escape codes don't
show as text here.) Bad input: wrong shape → `color needs a color name and text, like color("red", "hi").` · an unknown colour → `unknown color. Try: red green yellow blue magenta cyan white gray bold dim.`

### `show` (the keyword, not a builtin)

`show` isn't a function — it's a **statement** that prints its arguments separated by
a space, then a newline. It's how every other builtin's result reaches the screen.

```sprout
show "score:", 10, yes
```

```text
score: 10 yes
```

See [control flow & statements](control-flow.md) for `show` and friends.

---

## The error a builtin raises

Every builtin checks its inputs and raises a **friendly, catchable** error on bad
ones. The `kind` field on a caught error (`caught e:` → `e["kind"]`) is one of a
fixed set — branch on that, not on the message text:

| `kind` | when a builtin raises it | example |
| --- | --- | --- |
| `"error"` | wrong **number** or **shape** of arguments (the default) | `abs()`, `abs("x")`, `pow(2)` |
| `"type"` | a value of the wrong **kind** inside a collection op | `sum([1, "a"])`, `sort([1, "a"])`, `max(1, "a")` |
| `"math"` | a number op with no answer | `sqrt(-4)` |
| `"index"` | a list position that doesn't exist | `remove(xs, 99)`, `insert(xs, 99, 0)` |
| `"io"` | a file/store that can't be written | `write` to an unwritable path, `remember` when the store can't save |
| `"fail"` | your own `fail "..."` | — |
| `"name"` | an unknown variable/task/module — **not catchable** (a code typo) | mis-typed builtin or variable name |

Here's catching one and reading its kind:

```sprout
try:
    show sum([1, "a"])
caught e:
    show e["kind"]
    show e["message"]
```

```text
type
sum needs every item to be a number.
```

Note that `"name"` errors (a typo'd function or variable) **skip `try` entirely** —
they're code mistakes, and `try` deliberately won't swallow them:

```sprout
try:
    show undefinedThing
caught e:
    show "caught it"
```

```text

  Sprout error in ... (line 2): I don't know what 'undefinedThing' is.
  ...
```

The full model — the two tiers, the `caught` map shape, `fail` with a map — is in
[Errors & error handling](errors.md).

---

## Quick index of all 98

| Builtin | Group | Mutates? | Returns |
| --- | --- | --- | --- |
| `abs` | numbers | no | number |
| `ceil` | numbers | no | number |
| `floor` | numbers | no | number |
| `round` | numbers | no | number |
| `sqrt` | numbers | no | number |
| `pow` | numbers | no | number |
| `sin` / `cos` / `tan` | numbers | no | number |
| `exp` | numbers | no | number |
| `log` | numbers | no | number |
| `pi` | numbers | no | number |
| `args` | environment | no | list |
| `env` | environment | no | text / nothing |
| `exit` | environment | (ends program) | never |
| `min` | numbers | no | number |
| `max` | numbers | no | number |
| `clamp` | numbers | no | number |
| `sign` | numbers | no | number |
| `sum` | numbers/lists | no | number |
| `random` | random | no | number |
| `seed` | random | (rng state) | nothing |
| `now` | time | no | text |
| `today` | time | no | text |
| `wait` | time | no | nothing |
| `time` | time | no | number |
| `days` / `hours` / `minutes` | time | no | number |
| `time_parts` | time | no | map |
| `time_make` | time | no | number |
| `time_format` | time | no | text |
| `number` | conversion | no | number / nothing |
| `is_number` | conversion | no | yes/no |
| `kind_of` | inspection | no | text |
| `is_a` | inspection | no | yes/no |
| `json` | conversion | no | any |
| `upper` | text | no | text |
| `lower` | text | no | text |
| `title` | text | no | text |
| `trim` | text | no | text |
| `replace` | text | no | text |
| `split` | text | no | list |
| `join` | text | no | text |
| `words` | text | no | list |
| `lines` | text | no | list |
| `contains` | text/list/map | no | yes/no |
| `starts_with` | text | no | yes/no |
| `ends_with` | text | no | yes/no |
| `index_of` | text/list | no | number / nothing |
| `count` | text/list | no | number |
| `slice` | text/list | no | text / list |
| `length` | text/list/map | no | number |
| `pad_start` / `pad_end` | text | no | text |
| `code` | text | no | number |
| `char` | text | no | text |
| `matches` | regex | no | yes/no |
| `find` | regex | no | text / nothing |
| `find_all` | regex | no | list |
| `captures` | regex | no | list / nothing |
| `add` | lists | **yes** | nothing |
| `insert` | lists | **yes** | nothing |
| `remove` | lists/maps | **yes** | removed item |
| `first` | lists | no | item |
| `last` | lists | no | item |
| `sort` | lists | **yes (in place)** | same list |
| `sort_by` | lists | **yes (in place)** | same list |
| `reverse` | lists | **yes (in place)** | same list |
| `unique` | lists | no | list |
| `zip` | lists | no | list |
| `flatten` | lists | no | list |
| `range` | lists | no | list |
| `map` | lists | no | list |
| `filter` | lists | no | list |
| `reduce` | lists | no | any |
| `group_by` | lists | no | map |
| `min_by` / `max_by` | lists | no | an item |
| `partition` | lists | no | list of 2 lists |
| `chunk` | lists | no | list of lists |
| `copy` | lists/maps | no | new value |
| `keys` | maps | no | list |
| `values` | maps | no | list |
| `ask` | input | no | text |
| `read` | files | no | text / nothing |
| `write` | files | (file) | nothing |
| `append` | files | (file) | nothing |
| `exists` | files | no | yes/no |
| `get` | web | (network) | text / nothing |
| `explore` | web | no | list |
| `remember` | persistence | (store) | nothing |
| `recall` | persistence | no | any |
| `forget` | persistence | (store) | yes/no |
| `run` (`system.run`) | system | (shell) | text / nothing |
| `color` | output | no | text |

That's all 98 (counting `run`, reached as `system.run`).

---

## See also

- [Built-in functions](builtins-reference.md) — the friendly overview
- [Collections (lists & maps)](collections.md) — shared references, `copy`, iteration
- [Text](text.md) — strings, f-strings, indexing
- [Tasks & lambdas](tasks-and-lambdas.md) — the tasks you pass to `map`/`filter`/`reduce`/`sort_by`
- [Operators](operators.md) — `+` `|>` `to` `in` `or else`
- [Errors & error handling](errors.md) — `try`/`caught`, the error kinds
- [Sandbox & playground](sandbox-and-playground.md) — which builtins are turned off
- [Cheat sheet](cheatsheet.md) — everything on one page
- [How Sprout works](architecture.md) — under the hood
