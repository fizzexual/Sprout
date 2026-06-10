# Sprout Cheat Sheet (one page)

The whole language — as it works today — on one page. Skim it, copy a snippet,
change a number, run it. 🌱

> Sprout is being rebuilt in C; this sheet covers what runs today. f-strings, more
> builtins, and input are on the [roadmap](README.md#roadmap).

---

## The basics

```sprout
~ this is a comment

make x = 10           ~ create a variable
set x = x + 1         ~ change one you already made

show "hi", x          ~ print (commas join with spaces)  ->  hi 11
```

**Values:** numbers (`3`, `2.5`), text (`"hello"`), `yes` / `no` (booleans), and
`nothing` (the empty value).

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

## Running it

```bash
sprout.exe myprogram.sprout
```

See [Getting Started](getting-started.md) to build the `sprout` executable.
