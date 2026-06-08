# automations: files & folders 📁

The **automations** library can do your filing for you. It reads and writes text
files, keeps a tidy log, lists what's in a folder, finds the newest or biggest
file, measures sizes, makes backups and zips, keeps a quiet version history, and
can even sit in the background tidying your Downloads. Almost everything here is a
one-shot "do it now" action that finishes right away — the one exception is
`sort_downloads`, which keeps watching your Downloads folder in the background.

Add it to the top of your program:

```sprout
use "automations"

write_file("notes.txt", "hello")   ~ make a file next to your program
show read_file("notes.txt")        ~ read it back
```

> 📂 **Where do files go?** A bare name like `"notes.txt"` is resolved **next to
> your Sprout program**, so it lands right beside your code. The three special
> names `Downloads`, `Desktop`, and `Documents` point inside your user profile
> (like `C:\Users\you\Downloads`). Easy.

## Functions

| Function | What it does | Example |
| --- | --- | --- |
| `read_file("name")` | read a text file; gives `nothing` if it isn't there | `show read_file("notes.txt")` |
| `write_file("name", text)` | make or overwrite a file; gives back the name | `write_file("notes.txt", "hi")` |
| `append_file("name", text)` | add text to the end of a file (making it if needed) | `append_file("notes.txt", "more")` |
| `log("message")` | add a time-stamped line to `log.txt` (or a file you name) | `log("started up")` |
| `files("folder")` | list everything in a folder (files and subfolders) | `show files("Downloads")` |
| `newest("folder")` | full path of the most recently changed file (or `nothing`) | `show newest("Downloads")` |
| `oldest("folder")` | full path of the least recently changed file | `show oldest("Downloads")` |
| `biggest("folder")` | full path of the biggest file in a folder | `show biggest("Downloads")` |
| `foldersize("folder")` | total size of everything inside, as friendly text | `show foldersize("Documents")` |
| `count("folder")` | how many files a folder holds (subfolders too) | `show count("Downloads")` |
| `freespace()` | room left on a drive, as friendly text 🪟 | `show freespace()` |
| `open_folder("name")` | open a folder in File Explorer | `open_folder("Downloads")` |
| `backup("folder", "dest")` | copy a folder to another place, stamped with today's date | `backup("project", "E:\\Backups")` |
| `zip("name")` | squash a folder or file into a `.zip` 🪟 | `zip("project")` |
| `unzip("name.zip")` | unpack a `.zip` into a folder 🪟 | `unzip("photos.zip")` |
| `snapshot("name")` | save a quiet history copy of a file you can restore later | `snapshot("notes.txt")` |
| `restore("name")` | bring a file back from its newest snapshot | `restore("notes.txt")` |
| `versions("name")` | list a file's saved snapshots (oldest first) | `show versions("notes.txt")` |
| `sort_downloads()` | keep tidying Downloads into folders, in the background 🪟 | `sort_downloads()` |

🪟 = Windows only.

### A few friendly details

- **`read_file` is gentle.** If the file isn't there, you get `nothing` back
  instead of a crash, so you can check for it with `when`.
- **`newest`, `oldest`, and `biggest` give a full path.** They hand back the whole
  path to the winning file, or `nothing` if the folder has no files. You can also
  pass a file type to narrow it down: `newest("Downloads", "png")` looks at only
  `.png` files.
- **`foldersize` and `count` look inside subfolders too.** They add up everything,
  all the way down. `foldersize` gives friendly text like `"1.4 GB"`.
- **`log` stamps the time.** Each line looks like `14:05:09  started up`. By
  default it writes to `log.txt`; pass a second name to use a different file, like
  `log("done", "runs.txt")`.
- **`backup` stamps the date.** `backup("project", "E:\\Backups")` makes a folder
  like `E:\Backups\project-2026-06-08`. The backup spot must already exist (so it
  can warn you if the USB isn't plugged in), and it hands back the full path it
  made.
- **`zip` and `unzip` are Windows-only.** They use Windows' built-in archive tools.
  By default `zip("project")` makes `project.zip` right beside it, and
  `unzip("photos.zip")` unpacks into a `photos` folder beside it. You can pass a
  second name to choose the output.
- **`freespace` is Windows-only.** With no value it checks your `C:` drive; pass a
  drive letter like `freespace("E")` for another one. It gives text like
  `"42.0 GB free"`.
- **Snapshots are quiet and safe.** `snapshot` copies a file into a hidden
  `.sprout-history` folder next to your program, stamped with the date and time.
  `restore` copies the **newest** snapshot back over the current file, and
  `versions` lists every snapshot you've saved.
- **`sort_downloads` keeps running.** This one stays alive in the background,
  watching Downloads and filing new files into `Images`, `Docs`, `Videos`,
  `Music`, `Archives`, or `Other` once they finish downloading. Press `Ctrl+C` to
  stop. It's Windows-only.

## Example: a tiny note-taker with history

Save a note, keep a snapshot, then peek at the versions you've saved.

```sprout
use "automations"

write_file("notes.txt", "Buy milk")   ~ start fresh
snapshot("notes.txt")                 ~ keep a copy

append_file("notes.txt", "\nCall mum")
snapshot("notes.txt")                 ~ another copy

show read_file("notes.txt")           ~ see the latest
show versions("notes.txt")            ~ all the saved copies

~ changed your mind? bring back the newest snapshot:
~ restore("notes.txt")
```

## Example: a Downloads health check

Look around your Downloads folder before tidying it.

```sprout
use "automations"

show "You have", count("Downloads"), "files in Downloads."
show "They take up", foldersize("Downloads")
show "Biggest one:", biggest("Downloads")
show "Newest one:", newest("Downloads")

log("checked Downloads")   ~ jot it in log.txt
```

Want it filing itself from now on? Arm the background tidier:

```sprout
use "automations"

sort_downloads()   ~ keeps sorting new files until you stop it (Ctrl+C)
```

## See also

- [Libraries](../libraries.md) — how `use` works and what else **automations** offers
- [automations: system control](automations-system.md) — volume, dark mode, sleep, and more
- [automations: launch & control apps](automations-apps.md) — `launch`, `running`, `closeapp`
