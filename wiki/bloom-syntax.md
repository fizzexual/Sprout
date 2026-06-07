# Bloom Styling

**Bloom** is Sprout's own styling language — its version of CSS. A `.bloom` file
describes how an app looks. The same file styles **both** the native window and
the website.

## Attaching a stylesheet

In your Sprout program, point at a `.bloom` file with the `style` statement:

```sprout
style "mytheme.bloom"

window("My App")
...
```

**No `style` line = raw, unstyled output** — exactly like an HTML page with no CSS.

## Writing Bloom

A Bloom file is a list of **selectors**, each with indented **properties**.
Comments start with `~`.

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

#display:               ~ one widget, by its id
    size: 26
    text: #c9a8ff
```

## Selectors

| Selector | Targets |
| --- | --- |
| `window:` | the whole window / page |
| `label:` | every label |
| `button:` | every button |
| `field:` | every text box |
| `#someId:` | the single widget with that `id` |

An `#id` style **overrides** the matching kind style.

## Properties

| Property | Meaning | Example |
| --- | --- | --- |
| `background` | background color | `background: #0e1726` |
| `text` | text color | `text: #ffffff` |
| `font` | font family + optional size | `font: Segoe UI 14` |
| `size` | font size (number) | `size: 26` |
| `border` | border color | `border: #24364f` |
| `rounded` | corner roundness (number) | `rounded: 10` |
| `padding` | inner spacing (number) | `padding: 8` |
| `width` | width (number) | `width: 300` |

Colors are hex like `#7bd88f`. Not every property applies to every widget — the
native window and the website each use what makes sense.

## Tip

The `id` you style with `#id` is the same `id` you give a widget in your program,
e.g. `label("display", ...)` is styled by `#display:`.
