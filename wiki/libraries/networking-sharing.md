# networking: sharing to your phone

This part of the **networking** library lets you hand things to your phone with
almost no fuss. Share a single file as a download link, browse a whole folder,
pop some text onto a page with a Copy button, ping your phone with a push
notification, or print a scannable QR code right in your terminal. The sharing
servers run on your home Wi-Fi — open the printed `http://192.168.x.x:8000/`
link on a phone that's on the **same network** and it just works. To use it, add
this line near the top of your program:

```sprout
use "networking"
```

## Functions

| Function | What it does | Example |
| --- | --- | --- |
| `share("file")` | Start a tiny web server that lets your phone **download one file**. Returns the link. | `show share("photo.jpg")` |
| `serve("folder")` | Start a server that lets you **browse a whole folder** — the home page lists each file as a link. Returns the link. | `show serve("my-pictures")` |
| `sharetext("text")` | Start a server showing some **text on a page with a Copy button**. Returns the link. | `show sharetext("Wifi: hunter2")` |
| `sendphone("topic", "message")` | Send a **push notification** to your phone in one shot via [ntfy.sh](https://ntfy.sh). Returns nothing. | `sendphone("toms-alerts-92", "Dinner is ready!")` |
| `qr("text")` | Print a **scannable QR code** in the terminal. Returns nothing. | `qr("https://example.com")` |
| `qr("text", "file")` | Save the QR code as a **black-and-white PNG** instead. Returns the filename. | `qr("https://example.com", "code.png")` |

> The link from `share`, `serve`, and `sharetext` is also printed to your
> terminal when the program starts, next to a friendly label — so you don't have
> to `show` it if you'd rather not.

## The servers keep your program running

`share`, `serve`, and `sharetext` each start a small web server. Like a bot's
listen loop, those servers **keep Sprout alive** so your phone can reach them.
Your program won't exit on its own — press **Ctrl+C** when you're done.

Each server picks its own port, starting at **8000** and counting up. If a port
is already busy, Sprout quietly bumps to the next one and tells you the real link
it landed on.

## A few honest notes

- **Same Wi-Fi needed.** `share`, `serve`, and `sharetext` only work for phones
  on the **same local network** as your computer. They aren't reachable from the
  wider internet.
- **`sendphone` needs the ntfy app.** Install the free **ntfy** app on your
  phone, subscribe to your chosen topic, and the message arrives instantly. Pick
  a private, hard-to-guess topic word — anyone who knows it can post to it. This
  call needs an internet connection.
- **`serve` shows files only.** The folder listing links the plain files sitting
  directly inside the folder. Sub-folders aren't browsed, and requests are kept
  inside the shared folder (no sneaking out with `..`).
- **`share` always downloads.** The browser saves the file rather than previewing
  it. With `serve`, files open inline when the browser can (images, text, and so
  on).
- **QR is fully offline.** The QR encoder is built from scratch in Sprout's own
  code — no internet required. It handles links and short notes nicely. Very long
  text won't fit, and Sprout will tell you to try something shorter.
- Files for `share`, `serve`, and a saved `qr` PNG are looked for / written
  **next to your program**.

## Example: share a photo and ping your phone

```sprout
use "networking"

~ put photo.jpg next to this program first
show "Open this on your phone:", share("photo.jpg")

~ then nudge your phone so you know it's ready
sendphone("toms-alerts-92", "Your photo is ready to grab!")
```

When you run this, Sprout prints the link, sends the push, and **stays running**
so your phone can download the file. Press **Ctrl+C** to stop.

## Example: a QR code for your Wi-Fi note

```sprout
use "networking"

~ print a scannable code straight in the terminal
qr("https://sprout-lang.dev")

~ or save one as a picture you can show on a screen
make file = qr("https://sprout-lang.dev", "site-code.png")
show "Saved:", file
```

`qr(text)` draws the code with terminal blocks; `qr(text, "file")` writes a PNG
next to your program and gives you back the filename.

## See also

- [Libraries](../libraries.md) — the rest of the **networking** library (online
  checks, downloads, IP and host info) and how `use` works.
- [GUI & Servers](../gui-and-servers.md) — build full windows and websites in
  Sprout.
- [Builtins](../builtins.md) — every built-in function, including `secret(...)`.
