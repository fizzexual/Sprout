# Sprout examples 🌱

Real, runnable programs — the best way to learn Sprout (and to see that it can build
actual things, not just toy snippets). Each file is self-contained and commented.

Run any of them with:

```
sprout run examples/leaderboard.sprout
```

| Example | What it builds | Features it shows |
| --- | --- | --- |
| [`fizzbuzz.sprout`](fizzbuzz.sprout) | The classic FizzBuzz | tasks, `when`/`orwhen`/`otherwise`, `1 to 20` ranges |
| [`leaderboard.sprout`](leaderboard.sprout) | Ranks players by score | lists of maps, **`sort_by`**, `for each` |
| [`wordcount.sprout`](wordcount.sprout) | Most-common words in text | a map as a counter, `words`, `in`, `sort_by` + `slice` for top-N |
| [`units.sprout`](units.sprout) | Temperature / distance converter | `match`, `fail`, `map` with a lambda |
| [`bank.sprout`](bank.sprout) | Account ledger with overdraft errors | maps as records, `fail` + custom `kind`, `try`/`caught` |
| [`roman.sprout`](roman.sprout) | Number → Roman numerals | parallel lists, `repeat while`, string building |
| [`rpn.sprout`](rpn.sprout) | Reverse-Polish calculator (`3 4 + 5 *`) | a list as a stack, `words`, `number`, `match` |
| [`todo.sprout`](todo.sprout) | A to-do list saved to disk | `remember`/`recall`/`forget`, `or else`, nested data |

These also double as a smoke test of the language end-to-end: every one is expected to
run cleanly. New examples and improvements are welcome — the best feedback for the
language comes from building real things with it.
