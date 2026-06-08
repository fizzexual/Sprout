# GUI Apps & Websites

Sprout can build two kinds of apps from the **same building blocks**:

- a **native window** on your desktop, and
- a **website** that opens in your browser.

You write them almost identically. The only difference is one line near the
top: `window("Title")` for a window, or `server("Title")` for a website. When
you run the file, Sprout opens whichever one you chose.

```sprout
window("Hello")           ~ a desktop window
label("greeting", "Hi! 🌱")
```

```sprout
server("Hello")           ~ the same app, in the browser
label("greeting", "Hi! 🌱")
```

That's the whole idea. The rest of this page fills in the details.

## The building blocks

These are all the GUI functions Sprout has. You call them like any other
function: `name(args)`.

| Function | What it does | Example |
| --- | --- | --- |
| `window("Title")` | Make this app a **native window**. Sets the window title. | `window("My App")` |
| `server("Title")` | Make this app a **website**. Sets the page title. | `server("My Site")` |
| `label("id", "text")` | Show a line of text. Call again with the same `id` to **update** it. | `label("score", "Score: 0")` |
| `button("text", "taskName")` | Show a button. When clicked, it runs the task named `taskName`. | `button("Add one", "add")` |
| `field("id", "hint")` | Show a text box the user can type in. The hint is optional. | `field("name", "Type your name")` |
| `textof("id")` | Read what's currently typed in a field. Gives back text. | `make who = textof("name")` |

A few things to remember:

- Every name (the `"id"` and the `"taskName"`) goes **in quotes**.
- `window` and `server` set the title and pick the mode. Pick **one** — the
  last one you call wins.
- `field` takes 1 or 2 values. Without a hint, the box is just empty.
- `textof` on an unknown field gives back empty text `""`, so it's safe.

## How buttons call tasks

A button doesn't run code by itself. It points at a **task by name**, and runs
that task when clicked:

```sprout
task add():
    set count = count + 1
    label("display", "Count: " + count)

button("Add one", "add")     ~ the "add" here is the task above
```

Two rules to keep in mind:

- **A button's task takes no inputs.** Write it as `task add():` with empty
  parentheses. If it asks for inputs, Sprout will tell you so.
- **Your variables keep their values between clicks.** The program stays alive
  the whole time the window or site is open, so a counter really counts up.

If a button names a task that doesn't exist, Sprout gives a friendly error
telling you to define it.

## A counter (native window)

```sprout
make count = 0

task add():
    set count = count + 1
    label("display", "Count: " + count)

window("Counter")
label("display", "Count: 0")
button("Add one", "add")
```

Click **Add one** and the number goes up — and stays up. The `label("display", ...)`
call inside `add` reuses the same `id`, so it **replaces** the text instead of
adding a new line.

## A greeter with input

Use `field` to collect text, and `textof` to read it back:

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

Type a name, click **Greet me**, and the greeting updates. Leave it blank and
it falls back to "stranger".

## The same app as a website

Change `window` to `server` and you have a website instead:

```sprout
server("Greeter")
field("name", "Type your name")
label("greeting", "Hello!")
button("Greet me", "greet")
```

Everything else — your tasks, fields, labels, buttons — works exactly the same.
Sprout opens it in your browser automatically.

## Running your app

You usually just run the file, and Sprout opens whatever the program asked for:

```text
sprout myapp.sprout
```

You can also force a mode from the command line:

| Command | What it does |
| --- | --- |
| `sprout myapp.sprout` | Run it. Opens a window or website depending on `window(...)` / `server(...)`. |
| `sprout gui myapp.sprout` | Open it as a **native window**. |
| `sprout serve myapp.sprout` | Run it as a **website**. |

When you run a website, Sprout prints the address (like
`http://localhost:3000`) and opens your browser. If that port is busy, it
quietly tries the next few ports. You can pick a port yourself by setting the
`PORT` environment variable. Press **Ctrl+C** in the terminal to stop the site.
For a native window, just close the window.

## Native window vs website — which is which?

| | `window(...)` — native window | `server(...)` — website |
| --- | --- | --- |
| Where it runs | A desktop window on your computer | In a web browser |
| Who can see it | Just you, locally | Anyone who can reach the address |
| Needs a browser? | No | Yes |
| Platform | **Windows only** (see below) | Any system that runs Sprout |

The widgets, tasks, and styling are identical between the two. You can switch
back and forth by changing that one line.

### Windows-only caveat for native windows

Native windows are built with Windows' own tools (PowerShell and .NET
WinForms), so **`window(...)` only works on Windows**. There's nothing extra to
install — but on macOS or Linux it won't open a window.

If you're not on Windows, run your app as a website instead:

```text
sprout serve myapp.sprout
```

Sprout will even remind you of this if you try to open a native window on
another system.

## The hidden backend (a security note)

When you run a Sprout app as a `server`, your **whole program runs on the
server** — never in the visitor's browser. The browser only ever receives:

1. the **rendered page** (the labels, buttons, and fields it should show), and
2. a tiny **"a button was clicked"** message when someone clicks.

Your tasks, variables, data, and logic are **never sent to the browser**. A
visitor can't read them, copy them, or tamper with them. That's a real hidden
backend, living in the same file as your frontend.

On top of that, **only a task that's attached to a button can be triggered**
from the browser. A helper task that isn't on any button — one that checks a
password or touches your data — can't be reached from the outside at all:

```sprout
server("Secure App")
button("Log in", "login")

task login():
    ~ runs ONLY on the server, when the button is clicked
    checkPassword()

task checkPassword():
    ~ not on any button, so the browser can never call it directly
    ~ ... secret backend stuff lives safely here ...
```

If someone tries to invoke a task that isn't wired to a button, Sprout simply
refuses with "That action isn't available." This same rule protects native
window apps too.

## Styling

By itself, an app shows a **raw** look — plain text and plain buttons, like a
web page with no CSS. Add a design with one line:

```sprout
style "mytheme.bloom"
```

The same Bloom stylesheet works for both windows and websites, so your app
looks the same either way. See **[Bloom Styling](bloom-syntax.md)** for how to
write one.

## See also

- **[Bloom Styling](bloom-syntax.md)** — give your app colors, fonts, and spacing.
- **[Sprout Syntax](sprout-syntax.md#tasks-your-own-functions)** — tasks, `make`/`set`, and the basics your buttons run.
