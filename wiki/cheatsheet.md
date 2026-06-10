# Sprout Cheat Sheet (one page)

The whole language — as it works today — on one page. Skim it, copy a snippet,
change a number, run it. 🌱

> Sprout is being rebuilt in C; this sheet covers what runs today. See the
> [roadmap](README.md#roadmap) for what's next.

---

## The basics

```sprout
~ this is a comment

make x = 10           ~ create a variable
set x = x + 1         ~ change one you already made

show "hi", x          ~ print (commas join with spaces)  ->  hi 11
show f"hi {x}"        ~ f-string: drop values right into text  ->  hi 11
```

**Values:** numbers (`3`, `2.5`), text (`"hello"`), `yes` / `no` (booleans), and
`nothing` (the empty value).

**Text templates (f-strings):** `f"Hi {name}, score {x + y}"` — anything in `{ }`
is worked out and dropped in. Use `\{` for a literal brace.

**Math:** `+  -  *  /  %`  — use `(` `)` to group. `+` also joins text:
`"a" + "b"` → `ab`.

**Compare:** `==  !=  <  <=  >  >=`

**Logic:** `and`  `or`  `not`

```sprout
when 3 + 4 * 2 == 11:
    show "math works!"
```

---

## Choices: when / orwhen / otherwise

```sprout
make score = 5

when score > 8:
    show "great"
orwhen score == 5:
    show "okay"
otherwise:
    show "keep going"
```

`orwhen` and `otherwise` are optional. Indent the body (4 spaces is the Sprout style).

---

## Repeating

```sprout
repeat 3 times:        ~ a fixed number of times
    show "*"

make n = 3
repeat while n > 0:    ~ keep going while something is true
    show n
    set n = n - 1
```

---

## Lists

A list holds many values in order. Counting starts at **0**.

```sprout
make xs = [1, 2, 3]       ~ lists are written on one line
show xs[0]                ~ read by position  ->  1
set xs[1] = 9             ~ change an item
add(xs, 4)               ~ stick a value on the end
show length(xs)           ~ how many  ->  4
show first(xs), last(xs)  ~ ends
show contains(xs, 9)      ~ yes
```

## Maps

A map pairs **keys** with **values**.

```sprout
make person = {name: "Sam", age: 3}
show person["name"]       ~ look up by key  ->  Sam
set person["age"] = 4     ~ change a value
show keys(person)         ~ all the keys  ->  [name, age]
```

A missing key gives back `nothing`, so you can check `when person["x"] == nothing:`.

## for each

Walk a list's items, a map's keys, or the letters of some text.

```sprout
for each item in [10, 20, 30]:
    show item

for each i in range(3):   ~ 0, 1, 2
    show i

for each letter in "hi":
    show letter
```

---

## Tasks

A task is your own named action. `give` hands a value back to whoever called it.

```sprout
task greet(name):
    give "Hello, " + name

show greet("Sam")     ~ ->  Hello, Sam
```

Tasks can take any number of inputs, or none. A task without a `give` returns
`nothing`. Tasks can call themselves (recursion):

```sprout
task fib(n):
    when n < 2:
        give n
    give fib(n - 1) + fib(n - 2)

show fib(10)          ~ ->  55
```

> Tasks are defined at the **top level** (the far-left margin). A task sees the
> global variables plus its own — not the caller's locals.

---

## Projects: many files

Tie files together with a `sprout.toml`, expose things with `public`, and run it
all with `sprout build`. Full guide: **[Projects & modules](projects.md)**.

```sprout
~ modules/greeter.sprout
public task greet(who):     ~ 'public' = reachable as greeter.greet(...)
    give f"Hello, {who}!"
```

```sprout
~ app.sprout
use greeter                 ~ import the module
show greeter.greet("world") ~ call it by name (no hidden global sharing)
```

OS commands live in the **system** module:

```sprout
use system
show system.run("echo hi")
```

```bash
sprout new myapp     # scaffold a whole project folder
sprout build         # run the project (reads sprout.toml)
```

---

## learn mode: watch it run

```sprout
learn on
make x = 5
show x + 2          ~ narrates: Created x = 5, then 5 + 2 = 7, Output: 7
learn off
```

---

## Testing

```sprout
task greet(who):
    give f"Hello, {who}!"

test "greeting":
    expect greet("Sam") == "Hello, Sam!"   ~ each 'expect' must be true
    expect length([1, 2, 3]) == 3
```

```bash
sprout test                  # run every tests/*.sprout (or: sprout test myfile.sprout)
```

Each `test` runs on its own; a failing `expect` shows what it expected and the
run exits non-zero (handy for CI).

---

## Running it

```bash
sprout myprogram.sprout      # run one file
sprout build                 # run a project (sprout.toml in this folder)
sprout test                  # run your tests
sprout                       # open the interactive screen (try code live)
```

See [Getting Started](getting-started.md) to build the `sprout` executable.
