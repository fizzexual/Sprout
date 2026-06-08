# automations: keyboard / mouse / screenshot

This part of the **automations** library lets your program take over the
keyboard and mouse — just like a tiny robot sitting at your desk. You can type
text, press key combos, click and move the mouse, grab a screenshot, and copy
text to and from the clipboard. It's perfect for automating boring clicky
tasks, filling in forms, or building a little desktop helper.

Add it with `use` at the top of your program:

```sprout
use "automations"
```

> **Windows only.** Every macro here drives real Windows keyboard and mouse
> input through PowerShell, so it only works on Windows. On other systems
> you'll get a friendly error like `type works on Windows.`. Each macro is a
> *one-shot*: it runs, does its thing, and returns — nothing keeps running in
> the background.

## Functions

| Function | What it does | Example |
| --- | --- | --- |
| `type("text")` | Type text into whatever window has focus | `type("Hello from Sprout!")` |
| `press("combo")` | Press a key or key combo | `press("ctrl+s")` |
| `screenshot("file.png")` | Snap the whole screen to a file (saved next to your program) → the file name | `screenshot("shot.png")` |
| `screenshot("file.png", x, y, w, h)` | Snap just a rectangle of the screen | `screenshot("corner.png", 0, 0, 200, 200)` |
| `copy_text("text")` | Put text on the Windows clipboard | `copy_text("copied!")` |
| `clipboard()` | Read the clipboard back → the text, or `nothing` if empty | `show clipboard()` |
| `movemouse(x, y)` | Move the mouse pointer to a screen position | `movemouse(400, 300)` |
| `click()` / `click("right")` | Click where the mouse is now (left, or right) | `click()` |
| `mousepos()` | Where is the mouse right now? → `[x, y]` | `make where = mousepos()` |
| `typeto("title", "text")` | Bring a window to the front by (part of) its title, then type into it | `typeto("Notepad", "hi there")` |

### A few helpful details

**`type` and `typeto`** send your text one keystroke at a time, so they work in
almost any app. Special characters like `+`, `^`, `%`, `~`, `(`, `)`, `{`, `}`,
`[`, `]` are handled for you and typed literally.

**`press`** understands modifiers `ctrl`, `alt`, and `shift`, joined with `+`,
plus a final key. The key can be a single character or a friendly name:

- `enter` (or `return`), `esc` (or `escape`), `tab`, `space`, `insert`
- `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`
- `del` (or `delete`), `backspace` (or `back`)
- `f1` through `f12`

So `press("ctrl+s")`, `press("alt+f4")`, `press("ctrl+shift+s")`, and
`press("enter")` all work. The **Windows key isn't supported** — if you ask for
it, you'll get a gentle error.

**`screenshot`** saves a PNG next to your program and gives you back the file
name. With no region it grabs the whole (virtual) screen — handy if you use more
than one monitor. With five arguments it grabs just the rectangle you name; the
width and height must be positive.

**`clipboard`** gives back the clipboard text, or `nothing` when it's empty.
**`mousepos`** always gives back a two-item list `[x, y]`.

**`typeto`** matches the first window whose title *contains* the text you pass,
so `typeto("Notepad", "Hi!")` finds a window titled like `Untitled - Notepad`.
Open the app first — if no window matches, you'll get a friendly error.

## Examples

### Type a note into Notepad

```sprout
use "automations"

~ Open Notepad first, then run this.
typeto("Notepad", "Dear diary,")
press("enter")
type("today Sprout typed for me!")
```

### Copy text, take a screenshot, and check the mouse

```sprout
use "automations"

copy_text("Sprout was here")     ~ now it's on the clipboard
show "clipboard says:", clipboard()

make shot = screenshot("desktop.png")
show "saved", shot               ~ saved next to your program

make where = mousepos()
show "mouse is at", where        ~ e.g. [842, 517]

movemouse(400, 300)              ~ move it...
click()                          ~ ...and left-click there
```

## See also

- [Libraries](../libraries.md) — how `use` works and what else automations can do
- [Built-in Functions](../builtins.md) — the functions that come with Sprout
- [Getting Started](../getting-started.md) — write and run your first program
