# networking — friendly network tools

`use "networking"` adds simple, beginner-friendly tools for talking to the
network and the internet.

```sprout
use "networking"

show "This computer:", hostname()
show "Local IP:", localip()

when online():
    show "Public IP:", myip()
    show "google.com:", status("https://www.google.com")
    show "ping:", ping("google.com"), "ms"

download("https://example.com", "page.html")
```

| Function | What it does |
| --- | --- |
| `hostname()` | the name of this computer |
| `localip()` | this computer's address on your home/office network |
| `myip()` | your public IP — how the internet sees you |
| `online()` / `online("https://site")` | is the internet (or one site) reachable? → `yes` / `no` |
| `status("url")` | the HTTP status code (200 = OK, 404 = not found…), or `nothing` |
| `ping("host")` | round-trip time to a host in milliseconds, or `nothing` |
| `download("url", "file")` | save a file from the web next to your program; returns the filename |

The network calls run in a tiny Node subprocess so the functions stay
synchronous — the same no-dependency trick as the built-in
[`get`/`post`](../../wiki/builtins.md). `download` saves the file next to your
`.sprout` program.
