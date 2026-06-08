# networking: info & diagnostics

Ever wondered what your computer's name is, where in the world an IP address
lives, or how fast your internet really is? The **networking** library answers
all of that with friendly little functions. This page covers the **info &
diagnostics** part — the tools that *look at* the network and report back
(nothing here changes your computer).

Add the library at the top of your program:

```sprout
use "networking"

show "This computer is", hostname()
show "On the LAN at", localip()
show "Public IP:", myip()
```

After `use "networking"`, every function below works just like a built-in. Many
of them reach out to the internet, so they take a moment — and if they can't
reach what you asked for, they hand back `nothing` (or `no`) instead of crashing.

## Functions

| Function | What it does | Example |
| --- | --- | --- |
| `hostname()` | the name of this computer | `show hostname()` |
| `localip()` | this computer's address on your home/office network (falls back to `127.0.0.1`) | `show localip()` |
| `macaddress()` | the hardware (MAC) address of your main network card, like `A1-B2-C3-D4-E5-F6` | `show macaddress()` |
| `myip()` | your public IP — how the rest of the internet sees you | `show myip()` |
| `online()` | are we connected to the internet? → `yes` / `no` | `when online(): show "Online!"` |
| `online("https://site")` | is *that one site* reachable? → `yes` / `no` | `show online("https://github.com")` |
| `status("url")` | the HTTP status code of a web address (200 = OK, 404 = not found…), or `nothing` | `show status("https://example.com")` |
| `ping("host")` | round-trip time to a host in milliseconds, like a video-game ping (or `nothing`) | `show ping("google.com"), "ms"` |
| `download("url", "file")` | download a file from the web and save it next to your program; returns the filename | `download("https://example.com", "page.html")` |
| `isopen("host", port)` | is a particular port open on a host? Great for checking servers → `yes` / `no` | `show isopen("example.com", 443)` |
| `hops("host")` | trace the path your data takes to a host: a **list** of the routers it travels through | `show hops("google.com")` |
| `wifi()` | the name (SSID) of the Wi-Fi network you're on, or `nothing` if not on Wi-Fi | `show wifi()` |
| `wifisignal()` | how strong your Wi-Fi is, as a percent (100 = excellent), or `nothing` | `show wifisignal(), "%"` |
| `whereis("ip")` | roughly where an IP address is in the world — returns a **map** you can index, or `nothing` | `show whereis("8.8.8.8")["city"]` |
| `speedtest()` | measure your download speed in megabits per second (Mbps) by fetching ~25 MB, or `nothing` | `show speedtest(), "Mbps"` |
| `whois("domain")` | who owns a domain and when it was registered / expires — returns a **map**, or `nothing` | `show whois("example.com")["registrar"]` |

### A couple of details worth knowing

- **`whereis` gives you a map.** Index it just like any Sprout map:

  ```sprout
  set place to whereis("8.8.8.8")
  show place["city"], place["region"], place["country"]
  show place["isp"]
  show "at", place["lat"], "/", place["lon"]
  ```

  The keys are: `"city"`, `"region"`, `"country"`, `"isp"`, `"lat"`, `"lon"`.

- **`whois` also gives you a map**, with the keys `"registrar"`, `"created"`,
  and `"expires"`:

  ```sprout
  set info to whois("example.com")
  show info["registrar"]
  show "registered", info["created"]
  show "expires", info["expires"]
  ```

- **`hops` gives you a list** of router IP addresses — perfect for a `for each`:

  ```sprout
  for each router in hops("google.com"):
      show router
  ```

## Tiny examples

A quick "am I online?" check-up:

```sprout
use "networking"

show "I am", hostname()
show "Local IP:", localip()

when online():
    show "We're connected! 🌐"
    show "Public IP:", myip()
    show "google.com replied in", ping("google.com"), "ms"
otherwise:
    show "No internet right now. 😕"
```

Find out where you are in the world, and how fast your connection is:

```sprout
use "networking"

set place to whereis(myip())
when place == nothing:
    show "Couldn't look up your location."
otherwise:
    show "You appear to be in", place["city"], place["country"]
    show "Your provider is", place["isp"]

show "Testing download speed…"
show "You're getting about", speedtest(), "Mbps"
```

## Caveats (told honestly)

- **`wifi()` and `wifisignal()` are Windows-only.** On other systems they raise a
  friendly error asking you to check Wi-Fi from your system menu instead.
- **Anything that touches the internet can return `nothing`** (or `no`) — when the
  site is down, the address is wrong, or you're offline. Always be ready for that,
  like the location example above.
- **`whois` is best-effort.** It asks a public registry (RDAP). Some domains
  reply with less detail than others, so a key may come back empty.
- **`ping` and `hops`** use your system's `ping` / `tracert` (Windows) or
  `traceroute` (other systems) tools, and skip hops that don't answer.
- These calls happen one at a time and wait for an answer, so a slow `speedtest()`
  or `hops()` will pause your program for a few seconds — that's normal.

## See also

- [Libraries](../libraries.md) — every library and how `use` works
- [Built-in functions](../builtins.md) — the functions you get without any `use`
- [Sprout syntax](../sprout-syntax.md) — `make` / `set` / `show` / `when` / `for each` and friends
