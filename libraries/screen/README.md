# `screen` — see the screen and react 👀

```sprout
use "screen"
```

Sprout takes a snapshot of your screen, reads pixels, finds colours, and waits
for things to appear — then moves the mouse, clicks, and types. It's the engine
behind **watch-and-react helpers**: auto-clickers, idle-game minders, simple UI
bots, and accessibility scripts. It *reads* the screen and *sends* input — it
never touches another program's memory.

> Windows only (it uses Windows to grab the screen). It captures your **primary**
> monitor. A snapshot takes ~0.4s, so loops check a few times a second.

## A tiny example — click the first red thing you see

```sprout
use "screen"
make spot = find_color("red")
when spot != nothing:
    show "red at", spot[0], spot[1]
    click(spot[0], spot[1])
otherwise:
    show "no red on screen"
```

## Watch and react

```sprout
use "screen"
show "Waiting for a green light to appear..."
make spot = wait_for_color("green", 20, 30)   ~ tolerance 20, give up after 30s
when spot != nothing:
    click(spot[0], spot[1])
    show "Clicked it!"
```

## Seeing

| Word | What it does |
| --- | --- |
| `look()` | Take a fresh snapshot. The "seeing" words below use the latest one. |
| `screen_width()` / `screen_height()` | Size of the screen, in pixels. |
| `pixel(x, y)` | The colour at a point, as hex (e.g. `"#1a2b3c"`). |
| `find_color(color, tolerance?)` | Where the first matching pixel is → `[x, y]`, or `nothing`. |
| `sees_color(color, tolerance?)` | Is that colour on screen right now? → `yes` / `no`. |
| `count_color(color, tolerance?)` | How many pixels match (e.g. "how much red is showing?"). |
| `wait_for_color(color, tolerance?, seconds?)` | Snapshot until it appears → `[x, y]`, or `nothing` on timeout. |

**Colours** can be a name (`"red"`, `"lime"`, `"blue"`, `"white"`, `"black"`,
`"yellow"`, `"orange"`, `"purple"`, `"pink"`, `"cyan"`…), hex (`"#ff0000"`), or
`"255,0,0"`. **Tolerance** (default `16`) is how far off a pixel can be and still
count — raise it to match "close enough" colours.

## Reacting

| Word | What it does |
| --- | --- |
| `move_to(x, y)` | Move the mouse there. |
| `click(x?, y?)` | Left-click (at a point, or wherever the mouse is). |
| `right_click(x?, y?)` / `double_click(x?, y?)` | The other clicks. |
| `mouse()` | Where the mouse is → `[x, y]`. |
| `press("enter")` | Press a key (`"enter"`, `"tab"`, `"esc"`, `"f5"`, `"up"`…). |
| `type("hello")` | Type some text. |
| `wait(seconds)` | Pause — handy inside a watch loop. |

## Tips

- Call `look()` at the top of each loop turn to work from a fresh snapshot;
  `pixel`/`find_color`/`count_color` all read the latest one.
- A snapshot is ~0.4s, so a watch loop runs a couple of times per second — great
  for "wait for X, then click", not for twitch-speed reactions.
- Use it kindly: automate *your own* screen. Many online games disallow bots —
  check the rules before automating one.
