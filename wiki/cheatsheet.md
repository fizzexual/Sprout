# Sprout Cheat Sheet

The whole language on one page.

```sprout
~ comment

make x = 10           ~ create a variable
set x = x + 1         ~ change it

show "hi", x          ~ print (commas = spaces)

~ values: numbers, "text", yes, no, nothing
~ math:   + - * / %      (use () to group)
~ compare: == != < <= > >=
~ logic:  and  or  not

when x > 5:
    show "big"
orwhen x == 5:
    show "five"
otherwise:
    show "small"

repeat 3 times:
    show "*"

repeat while x > 0:
    set x = x - 1

task add(a, b):       ~ define a task
    give a + b        ~ hand back a value
show add(2, 3)        ~ call it -> 5
```

## Built-in functions

```
abs round floor ceil sqrt      min(...) max(...)
length(text) upper(text) lower(text)      random()
remember("key", value)   recall("key", default)   ~ save/load between runs
get("url")   post("url", body)   jsonpick(text, "key")          ~ internet
get_api_points(text)   explore(text)                          ~ what does an API offer?
```

## GUI / Server

```sprout
style "theme.bloom"           ~ optional design (raw if omitted)

window("Title")               ~ a native window app
server("Title")               ~ ...or a website

label("id", "text")           ~ text (re-call same id to update)
button("text", "taskName")    ~ runs a task on click
field("id", "hint")           ~ text input
textof("id")                  ~ read a field
```

## Bloom (`.bloom`)

```bloom
window:                       ~ or label / button / field / #id
    background: #1a1030
    text: #f0e9ff
    font: Segoe UI 14
    rounded: 12               ~ size, border, padding, width too
```

## Commands

```
sprout run file.sprout
sprout gui file.sprout
sprout serve file.sprout
sprout check file.sprout    ~ verify without running
sprout api <url>            ~ connect to an API + list everything it offers
sprout repl
```

→ Full docs: [Sprout Syntax](sprout-syntax.md) · [Bloom](bloom-syntax.md) · [GUI & Servers](gui-and-servers.md)
