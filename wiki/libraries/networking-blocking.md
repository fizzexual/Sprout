# networking: blocking websites

Sometimes you just need a website to *go away* for a while — to focus, to take a break, or as a tiny parental control. The **networking** library can block sites right on this computer. A blocked site won't load in *any* browser, because Sprout quietly points its name at `127.0.0.1` (this computer) in the system **hosts file**, so the request never reaches the real server. Sprout tags every line it adds, so unblocking only ever touches what Sprout wrote — never your own hosts entries. Add it with:

```sprout
use "networking"
```

> **Admin needed.** Blocking and unblocking edit the system hosts file, so you must run your program as **administrator** (Windows) or with **sudo** (others). On Windows, right-click your terminal or VS Code and choose **Run as administrator**. The read-only functions `isblocked` and `blocked` work fine *without* admin.

## Functions

| Function | What it does | Example |
| --- | --- | --- |
| `block("site.com")` | Block a website on this computer — it won't load in any browser. Needs admin. | `block("youtube.com")` |
| `unblock("site.com")` | Allow a site you blocked earlier again. Needs admin. | `unblock("youtube.com")` |
| `isblocked("site.com")` | Is this site blocked right now? → `yes` / `no`. Read-only — no admin. | `show isblocked("youtube.com")` |
| `blocked()` | A list of every site you've blocked (with `www.` stripped). Read-only — no admin. | `show blocked()` |
| `unblock_all()` | Remove *every* site Sprout blocked, all at once. Needs admin. | `unblock_all()` |
| `block_category("name")` | Block a whole bundle of sites by theme. Needs admin. | `block_category("social")` |
| `unblock_category("name")` | Unblock a whole bundle you blocked with `block_category`. Needs admin. | `unblock_category("social")` |
| `block_until("site.com", time)` | Block a site **now**, then free it automatically later. Needs admin. | `block_until("reddit.com", "30 minutes")` |

Addresses are tidied for you: `block("https://www.YouTube.com/feed")` becomes `youtube.com`. The scheme, path, `www.`, and capital letters are all stripped, so you can paste in whatever's easiest.

### Categories

`block_category` and `unblock_category` know these bundles:

| Category | Sites it covers |
| --- | --- |
| `ads` | doubleclick.net, googlesyndication.com, googleadservices.com, google-analytics.com, adservice.google.com, ads.yahoo.com, adnxs.com, advertising.com, scorecardresearch.com, taboola.com, outbrain.com |
| `social` | facebook.com, instagram.com, tiktok.com, twitter.com, x.com, reddit.com, snapchat.com |
| `gaming` | steampowered.com, epicgames.com, roblox.com, ea.com, twitch.tv, miniclip.com, poki.com |
| `news` | cnn.com, bbc.com, nytimes.com, foxnews.com, buzzfeed.com, reuters.com, theguardian.com |

If you ask for a category Sprout doesn't know, it lists the ones it *does* know — so a typo is easy to fix.

### Telling the time for `block_until`

The time can be a plain **number of seconds**, or friendly text. All of these work:

```sprout
block_until("reddit.com", 600)          ~ 600 seconds
block_until("reddit.com", "30 minutes") ~ same thing, in words
block_until("reddit.com", "2h")         ~ short form
block_until("reddit.com", "1 day")
```

Units understood: seconds (`s` / `sec` / `second`), minutes (`m` / `min` / `minute`), hours (`h` / `hr` / `hour`), and days (`d` / `day`). No unit means seconds. While a timed block is still counting down, your program stays alive so it can free the site at the right moment — and if you re-run later, Sprout sweeps away any timed blocks whose moment has already passed.

## Examples

A quick focus toggle — block a site, check it, then let it back in:

```sprout
use "networking"

block("youtube.com")
show isblocked("youtube.com")   ~ -> yes
show blocked()                  ~ -> ["youtube.com"]

unblock("youtube.com")
show isblocked("youtube.com")   ~ -> no
```

A focus session — silence all social media for half an hour, then tidy up:

```sprout
use "networking"

block_category("social")
show "Social media is off. Time to focus!"
show blocked()

block_until("reddit.com", "30 minutes")   ~ frees itself later

~ ...later, when you're done...
unblock_category("social")
unblock_all()                              ~ clears anything Sprout still has blocked
```

## Caveats

- **Editing the hosts file needs admin / sudo.** `block`, `unblock`, `unblock_all`, `block_category`, `unblock_category`, and `block_until` all change the hosts file. `isblocked` and `blocked` are read-only and run without admin.
- **Browser Secure DNS can dodge the block.** Some browsers have a *Secure DNS* (DNS-over-HTTPS) setting that looks up sites over the internet and skips the hosts file. If a blocked site still loads, turn off Secure DNS in your browser's settings.
- **Best-effort DNS flush.** After each change, Sprout asks Windows to forget cached lookups (`ipconfig /flushdns`) so the block takes effect right away. It never fails loudly if that can't run.
- The hosts file is sometimes briefly locked (by antivirus or the DNS service). Sprout retries automatically; if it stays stuck, pause real-time antivirus or close any hosts editor and try again.

## See also

- [Libraries](../libraries.md) — how `use` works and what else ships in the box
- [Built-in functions](../builtins.md) — the functions available everywhere, no `use` needed
