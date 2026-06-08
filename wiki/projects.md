# Projects — connecting files

Small programs live happily in one file. But once a program grows — a quiz, a
game, a bot — you want to split it into pieces that each do one job. Sprout lets
you **connect files together** with the same `use` you already know.

## `use "otherfile.sprout"`

Put your tasks in one file:

```sprout
~ scoring.sprout
task percent(score, total):
    give round(score / total * 100)

task medal(pct):
    when pct == 100:
        give "🥇 Perfect!"
    orwhen pct >= 60:
        give "🥈 Passed"
    otherwise:
        give "🥉 Keep practising"
```

…and use them from another:

```sprout
~ quiz.sprout
use "scoring.sprout"

make pct = percent(4, 5)
show pct, "%"
show medal(pct)
```

Run the **entry** file and Sprout pulls in everything it needs:

```bash
sprout run quiz.sprout
```

That's the whole feature. Every `task` defined in an imported file becomes
callable in yours, exactly as if you'd written it there.

## How it works

- The path is **relative to the file that writes the `use`** — so a file can
  `use "helpers/math.sprout"` and Sprout looks next to *that* file.
- Imports can chain: file A can `use` file B, which `use`s file C. Sprout loads
  the deepest dependencies first, so everything is ready before it runs.
- Loops are safe — if two files `use` each other, Sprout loads each one once and
  doesn't go in circles.
- **The whole project is checked before a single line runs.** `sprout check
  quiz.sprout` verifies every connected file and tells you which file a problem
  is in.

## What gets shared

Imported files contribute their **tasks** (your reusable functions). The file
you actually run — the **entry** file — is the one whose top-level steps execute.
So keep your "do the thing" code in the entry file, and put the reusable helpers
in the files you `use`.

```
quiz.sprout        ← you run this   (the steps: ask questions, show the score)
├── use "questions.sprout"   ← gives task questions()  (the data)
└── use "scoring.sprout"     ← gives task percent(), medal()  (the maths)
```

> **Libraries vs. files.** `use "discord-bot"` (no `.sprout`) adds a built-in
> [library](libraries.md). `use "scoring.sprout"` (ends in `.sprout`) pulls in
> *your own* file. Same word, and Sprout tells them apart by the `.sprout`.

## A full example

The [`advanced/quiz-game`](https://github.com/fizzexual/Sprout-) project is three
connected files:

| File | Job |
| --- | --- |
| `questions.sprout` | `task questions()` → a list of question/answer maps (the data) |
| `scoring.sprout` | `task percent(...)`, `task medal(...)` (the maths) |
| `quiz.sprout` | the entry — asks each question, grades, shows the medal |

```sprout
~ quiz.sprout  (shortened)
use "questions.sprout"
use "scoring.sprout"

make all = questions()
make score = 0

for each q in all:
    make answer = ask(q["question"] + " ")
    when lower(answer) == lower(q["answer"]):
        set score = score + 1
        show "✓ correct!"

make pct = percent(score, length(all))
show "You scored", score, "/", length(all), "  (" + pct + "%)"
show medal(pct)
```

Run it, answer the questions, and the three files work together as one program.

## See also

- [Sprout Syntax](sprout-syntax.md#tasks-functions) — defining the tasks you share
- [Libraries](libraries.md) — `use "name"` for built-in powers like `discord-bot`
- [Cheat Sheet](cheatsheet.md)
