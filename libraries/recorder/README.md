# `recorder` — record your input, then replay it 🎬

```sprout
use "recorder"
record("my-macro.txt")     ~ records everything until you press ESC
play("my-macro.txt")       ~ does it all again, with the same timing
```

Sprout watches **every mouse move, click, and key press/hold** (with timing),
saves it to a plain text file, and plays it back exactly. Perfect for repetitive
tasks — fill the same form, do the same clicks, run a practised routine. It
records and sends real input; it never touches another program's memory.

While it works, a small banner floats on top so you always know the state —
**red "Recording — press ESC to stop"** while capturing, **green "Playing
back…"** while replaying.

> Windows only. **Press ESC to stop recording.** Replaying sends input to
> whatever window is focused, so switch to the right window first (the example
> below gives you a 3-second head start).

## The words

| Word | What it does |
| --- | --- |
| `record(file, seconds?)` | Record mouse + keyboard to `file`. Stops when you press **ESC** (or after `seconds`, if you pass it). |
| `play(file, times?)` | Replay `file` with its original timing. Pass `times` to repeat. |
| `wait(seconds)` | Pause — handy before a replay so you can switch windows. |

## Record it

```sprout
use "recorder"
show "Recording your mouse + keyboard..."
show "Do your thing, then press ESC to stop."
record("my-macro.txt")
show "Saved! Run replay.sprout to play it back."
```

## Replay it

```sprout
use "recorder"
show "Replaying in 3 seconds — click into the right window now!"
wait(3)
play("my-macro.txt")          ~ play once
~ play("my-macro.txt", 5)     ~ ...or 5 times in a row
show "Done!"
```

## How it works

While recording, Sprout checks the mouse position and every key/button ~125
times a second and notes each change with a timestamp. The file is just lines
like `120 m 840 460` (mouse moved at 120 ms) and `300 d 65` / `360 u 65` (the `A`
key went down then up). Replay walks the lines and re-creates each event at the
same moment, using Windows' own input functions — so it looks just like you did
it.

## Tips

- The macro replays at the **same screen positions**, so keep windows where they
  were when you recorded.
- Use it on **your own** machine for your own tasks. Many online games disallow
  automation — check the rules before recording one.
