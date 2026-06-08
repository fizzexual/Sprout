# networking: web & data

Want to peek at the weather, check when a website's HTTPS certificate runs out,
look up the addresses behind a domain name, or shrink a giant link? The
**networking** library has a friendly little toolbox for all of that. This page
covers the **web & data** part — handy lookups that reach out to the internet
(or read a site's certificate) and hand you back a tidy answer.

Add the library at the top of your program:

```sprout
use "networking"

show weather("London")
show ssl_expiry("github.com"), "days"
show shorten("https://a-very-long-url.example.com/page")
```

After `use "networking"`, every function below works just like a built-in. They
all use free, keyless public services (or Node's built-in `node:tls` for
certificates), so there's nothing to sign up for. Because each one reaches out to
the network and waits for an answer, it pauses your program for a moment — and if
it can't find what you asked for, it hands back `nothing` (rather than crashing).

## Functions

| Function | What it does | Example |
| --- | --- | --- |
| `weather("city")` | the current weather for a city, as a short line of **text** like `London: 🌤  +16°C`, or `nothing` | `show weather("Tokyo")` |
| `mac_vendor("mac")` | the company that made a network card, from its MAC address — **text**, or `nothing` if unknown | `show mac_vendor("A4-83-E7-00-00-00")` |
| `ssl_expiry("host")` | how many days until a site's HTTPS certificate expires — a **number**, or `nothing` | `show ssl_expiry("github.com"), "days"` |
| `ssl_expiry("host", port)` | same, but check a specific port (default is `443`) | `show ssl_expiry("example.com", 8443)` |
| `cert("host")` | details about a site's HTTPS certificate — a **map** you can index, or `nothing` | `show cert("github.com")["issuer"]` |
| `dns("name")` | the addresses a domain name points to (`A` records) — a **list** | `for each ip in dns("example.com"): show ip` |
| `dns("name", "type")` | the same lookup for another record type, like `"MX"` or `"TXT"` | `show dns("example.com", "MX")` |
| `headers("url")` | the HTTP headers a web address sends back — a **map** you can index | `show headers("https://example.com")["content-type"]` |
| `shorten("url")` | make a long web address into a short one (via is.gd) — **text**, or `nothing` | `show shorten("https://example.com/a/very/long/path")` |
| `expand("url")` | follow a short link to where it really goes, and give back the final address — **text** | `show expand("https://bit.ly/xyz")` |
| `filesize("url")` | how big a download is, in megabytes (MB), without downloading it — a **number**, or `nothing` | `show filesize("https://example.com/big.zip"), "MB"` |

### The maps and lists, up close

- **`cert` gives you a map.** Index it just like any Sprout map:

  ```sprout
  set c to cert("github.com")
  show "issued by", c["issuer"]
  show "covers", c["subject"]
  show "expires", c["expires"]
  show "in", c["days"], "days"
  show "still valid?", c["valid"]
  ```

  The keys are: `"issuer"` (who signed it), `"subject"` (the name it covers),
  `"expires"` (a date like `2026-09-01T12:00:00.000Z`), `"days"` (a number, or
  `nothing` if unreadable), and `"valid"` (`"yes"` or `"no"`).

- **`dns` gives you a list** of addresses — perfect for a `for each`:

  ```sprout
  for each ip in dns("example.com"):
      show ip
  ```

- **`headers` gives you a map** of header names to values:

  ```sprout
  set h to headers("https://example.com")
  show h["content-type"]
  show h["server"]
  ```

## Tiny examples

A quick health check on a website's certificate:

```sprout
use "networking"

set site to "github.com"
set days to ssl_expiry(site)

when days == nothing:
    show "Couldn't read the certificate for", site
orwhen days < 14:
    show "⚠️  Heads up:", site, "expires in", days, "days!"
otherwise:
    show site, "is good for", days, "more days. ✅"

set c to cert(site)
show "It was issued by", c["issuer"]
```

Tidy up a long link, then check what a short one really points to:

```sprout
use "networking"

set short to shorten("https://example.com/some/really/long/path?ref=newsletter")
when short == nothing:
    show "Couldn't shorten that one."
otherwise:
    show "Short link:", short

show "That redirects to:", expand(short)
```

See the weather and look up a domain's addresses:

```sprout
use "networking"

show weather("Paris")

show "example.com lives at:"
for each ip in dns("example.com"):
    show "  ", ip
```

## Caveats (told honestly)

- **These all need internet** — except `ssl_expiry` and `cert`, which still need
  to *reach* the site to read its certificate. When you're offline or the address
  is wrong, you'll get a friendly "Network problem" message, or `nothing` back.
- **Anything can return `nothing`.** A typo'd city, an unknown MAC, a site that
  won't share its file size — these hand back `nothing` instead of crashing, so
  check for it (like the certificate example above).
- **`filesize` only works when the server says how big the file is.** It reads the
  `content-length` header without downloading; if the server doesn't send one,
  you get `nothing`.
- **`shorten` and `expand` follow real links.** Be a little careful expanding
  short links from strangers — `expand` will visit the address to find where it
  lands.
- These lookups happen one at a time and wait for an answer, so a slow site will
  pause your program for a few seconds — that's normal.

## See also

- [Libraries](../libraries.md) — every library and how `use` works
- [networking: info & diagnostics](networking-info.md) — hostname, IP, ping, speed test and more
- [networking: monitoring](networking-monitoring.md) — watch your connection over time
