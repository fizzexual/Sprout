# Bloom — the styling language

**Bloom** is Sprout's own little styling language — its version of CSS. A
`.bloom` file describes how your app *looks*: colors, fonts, rounded corners, and
so on.

The best part: the **same** `.bloom` file styles **both** the native window and
the website. Write your theme once, and your app looks the same whether it runs
as a desktop window or in a browser.

If you don't attach a Bloom file, that's fine too — your app just shows up in a
plain, raw look. More on that below.

## Attaching a stylesheet

In your Sprout program, point at a `.bloom` file with the `style` statement near
the top:

```sprout
style "mytheme.bloom"

window("My App")
label("greeting", "Hello!")
```

That's it. When your app runs, Sprout reads `mytheme.bloom` and paints everything
to match.

### Raw by default

**No `style` line = no theme = a raw, unstyled look** — exactly like an HTML page
with no CSS. Your widgets still work perfectly; they just wear their plain
default clothes.

```sprout
~ No style line here, so this app looks plain (but still works!)
window("Plain App")
label("hi", "I still run great.")
```

So Bloom is always optional. Add it when you want your app to look nice; skip it
when you just want things working.

## Writing a Bloom file

A Bloom file is a list of **selectors**. Each selector names *what* you want to
style, and underneath it you list **properties** (indented) that say *how* it
should look.

```bloom
~ mytheme.bloom

window:                 ~ the whole window / page
    background: #1a1030
    text: #f0e9ff
    font: Segoe UI 14

button:                 ~ every button
    background: #8a5cff
    text: #ffffff
    rounded: 12

#greeting:              ~ one widget, by its id
    size: 26
    text: #c9a8ff
```

The rules are short and friendly:

- A **selector** is a line that is *not* indented, like `button:`. The trailing
  `:` is optional but reads nicely.
- A **property** is an *indented* line like `background: #8a5cff`. The part
  before the `:` is the property name; the part after is the value.
- **Comments** start with `~`. Everything after a `~` on a line is ignored, so
  you can leave notes anywhere.
- **Blank lines** are ignored, so space things out however you like.
- Property names are **case-insensitive** (`Background` and `background` mean the
  same thing). Values are kept exactly as you wrote them.

## Selectors — what you can target

There are five kinds of selector. The first four match a *kind* of widget; the
last one matches a single widget by its `id`.

| Selector | Targets |
| --- | --- |
| `window:` | the whole window / page |
| `label:` | every label |
| `button:` | every button |
| `field:` | every text box |
| `#someId:` | the single widget whose `id` is `someId` |

### How `#id` works (and a gotcha)

A widget's `id` comes straight from your Sprout program. For example:

```sprout
label("greeting", "Hello!")    ~ this label's id is "greeting"
field("name", "Type here")     ~ this field's id is "name"
```

...so you style them with `#greeting:` and `#name:`.

A `#id` style is **layered on top** of the matching kind style. If both `label:`
and `#greeting:` set a property, the `#id` value wins for that one widget. Think
of it as: kind first, then your specific tweaks.

> **Heads up about buttons.** A button is written
> `button("Click me", "taskName")`. The first value is the button's *text*, and
> the second is the *task* it runs — **neither one is an id**. Sprout gives each
> button an automatic id like `button-0`, so `#id` styling is mainly handy for
> **labels** and **fields**, which you name yourself. To style buttons, use the
> `button:` selector to style them all at once.

## Properties — what you can change

Here are all the properties Bloom understands, with what they do and a tiny
example.

| Property | What it does | Example |
| --- | --- | --- |
| `background` | background color | `background: #0e1726` |
| `text` | text color | `text: #ffffff` |
| `font` | font family, plus an optional size at the end | `font: Segoe UI 14` |
| `size` | font size, in points (a number) | `size: 26` |
| `border` | border color (drawn as a 1px line) | `border: #24364f` |
| `rounded` | how round the corners are (a number) | `rounded: 10` |
| `padding` | inner spacing around the contents (a number) | `padding: 8` |
| `width` | width in pixels (a number) | `width: 300` |

A few notes so nothing surprises you:

- **Colors** are hex, like `#7bd88f`. Type the `#` and six hex digits.
- **Numbers** are just numbers — write `rounded: 10`, not `rounded: 10px`.
  Sprout adds the units for you.
- The **`font`** value is a family name with an optional size at the end, e.g.
  `font: Segoe UI 14` means the *Segoe UI* family at size *14*. Leave the number
  off (`font: Segoe UI`) to set just the family.
- You can set the font size two ways: tack a number onto `font`, or use a
  separate `size:` line. Both end up as the font size.
- Any property name Bloom doesn't recognize is simply ignored, so a typo won't
  crash your app — it just won't do anything.

### One window, two homes

Bloom feeds the same theme to two places: the **native window** and the **web
server**. Not every property makes sense in both places, so each backend uses the
ones that fit and quietly ignores the rest. Don't worry about memorizing which is
which — style what you want, and each backend picks up what it can.

## The default look (if you skip Bloom's colors)

Sprout ships with a built-in green theme it can fall back on. It's a nice
reference for the shape of a real Bloom file:

```bloom
window:
    background: #0f1410
    text: #e6efe6
    font: Segoe UI 13

label:
    size: 16

button:
    background: #7bd88f
    text: #08120a
    rounded: 10

field:
    background: #161d17
    text: #e6efe6
    border: #28321f
```

Copy this into your own `.bloom` file and start tweaking — change a color here,
bump a `rounded` there, and watch your app transform.

## A complete tiny example

Here's a small app and a theme that styles it.

`counter.sprout`:

```sprout
style "counter.bloom"

window("Counter")
make count to 0
label("display", "Count: 0")

task bump:
    set count to count + 1
    label("display", "Count: " + count)

button("Add one", "bump")
```

`counter.bloom`:

```bloom
~ counter.bloom

window:                 ~ the whole window / page
    background: #1a1030
    text: #f0e9ff
    font: Segoe UI 14

button:                 ~ every button
    background: #8a5cff
    text: #ffffff
    rounded: 12
    padding: 8

#display:               ~ just the count label
    size: 26
    text: #c9a8ff
```

The label has the id `"display"`, so `#display:` styles only that label. The
button is styled by the `button:` selector (remember: buttons don't have ids you
choose).

## Quick reference

- Attach with `style "file.bloom"`. No `style` line = raw, unstyled look.
- Selectors: `window:`, `label:`, `button:`, `field:`, and `#id:`.
- `#id` overrides the matching kind style for one widget.
- Properties: `background`, `text`, `font`, `size`, `border`, `rounded`,
  `padding`, `width`.
- Comments start with `~`. Numbers have no units. Colors are hex.
- Unknown selectors and properties are ignored, so you can experiment freely.

## See also

- [GUI and servers](gui-and-servers.md) — the `window`, `label`, `button`, and
  `field` widgets that Bloom styles.
- [Sprout syntax](sprout-syntax.md) — the `style` statement and the rest of the
  language.
- [Cheatsheet](cheatsheet.md) — every statement and widget on one page.
