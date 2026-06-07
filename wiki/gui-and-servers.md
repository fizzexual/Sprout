# GUI & Servers

Sprout can build **native windows** and **websites** — both written the same
way, with the same building blocks. The only difference is one line:

- `window("Title")` → a **native window** app
- `server("Title")` → a **website** (served in the browser)

When you open the file, Sprout launches whichever you chose.

## Building blocks

| Function | What it does |
| --- | --- |
| `window("Title")` | make this app a native window |
| `server("Title")` | make this app a website |
| `label("id", "text")` | show text. Call again with the same `id` to **update** it |
| `button("text", "taskName")` | a button that runs the task `taskName` when clicked |
| `field("id", "hint")` | a text box the user can type in |
| `textof("id")` | read what's currently typed in a field |

Buttons refer to a [task](sprout-syntax.md#tasks-functions) **by name** (in
quotes). When clicked, that task runs — and your variables keep their values
between clicks.

## A counter (native window)

```sprout
style "counter.bloom"      ~ optional design (see Bloom)

make count = 0

task add():
    set count = count + 1
    label("display", "Count: " + count)

window("Counter")
label("display", "Count: 0")
button("Add one", "add")
```

Click **Add one** and the number goes up — and stays up.

## A greeter with input

```sprout
task greet():
    make who = textof("name")
    when who == "":
        set who = "stranger"
    label("greeting", "Hello, " + who + "!")

window("Greeter")
field("name", "Type your name")
label("greeting", "Hello!")
button("Greet me", "greet")
```

## The same thing as a website

Change `window` to `server`:

```sprout
server("My Site")
label("title", "Welcome! 🌱")
button("Click me", "onClick")
```

Open it and it runs in your browser instead of a window. Everything else is
identical.

## Styling

By itself, an app shows a **raw** look (like a web page with no CSS). Add a
design with one line:

```sprout
style "mytheme.bloom"
```

See **[Bloom Styling](bloom-syntax.md)**.
