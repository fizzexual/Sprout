# Sprout libraries

Add extra powers to Sprout with **`use`**:

```sprout
use "discord-bot"
```

Put it at the top of your program, and the library's functions become available
like any built-in.

| Library | What it does |
| --- | --- |
| [discord-bot](discord-bot) | make a Discord bot |

## How a library works

Each library is a folder here with an `index.ts` that exports `create(interp)`:

```ts
export function create(interp) {
  return {
    names: ["greet"],                        // the builtin names it adds
    builtins: { greet: (args) => "hi " + args[0] },
    isActive: () => false,                    // did the program turn it on?
    start: () => { /* optional long-running runtime, e.g. a bot */ },
  };
}
```

When a program says `use "x"`, the Sprout CLI loads `libraries/x/index.ts`,
registers its `builtins`, lets the verifier know their `names`, and — if the
library is **active** after the program runs — calls `start()` (so a bot can keep
listening). That's the whole contract; add your own library by dropping in a new
folder.
