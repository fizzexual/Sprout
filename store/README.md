# 🛒 Sprout Store — a web app written **entirely** in Sprout

A small but complete e-commerce site — **no other language, no external server.** Sprout
serves the HTTP itself with the built-in `serve()` function. It has:

- **A storefront** — browse a product catalog, view product pages.
- **Accounts & auth** — register, log in / out, cookie sessions, password hashing.
- **A cart & checkout** — add items, see your cart total, place an order (stock decrements).
- **Your orders** — every order you've placed.
- **An admin dashboard** — revenue / order / product / customer stats, recent orders, and a
  form to add new products. Gated to admins only.
- **Styled in Bloom 🌸** — even the stylesheet is Sprout. The look is authored in Bloom,
  Sprout's own stylesheet language, and compiled to CSS by Sprout itself.

```
$ cd store
$ sprout run app.sprout
🌱 Sprout Store is open — visit http://localhost:8090   (admin / admin for the dashboard)
```

Open **http://localhost:8090**, register an account, shop — and log in as the seeded admin
(`admin` / `admin`) to see the dashboard.

## How it works — 100% Sprout

`app.sprout` *is* the web server. Sprout's `serve(port, handler)` opens a TCP server and, for
every request, calls a Sprout task with a request map and sends back the response the task
returns:

```sprout
task handle(req):
    when req["path"] == "/":
        give {"status": 200, "body": "<h1>Hello from Sprout</h1>"}
    give {"status": 404, "body": "not found"}

serve(8090, handle)
```

- **`req`** is a map: `req["method"]`, `req["path"]`, `req["params"]` (query + form fields),
  `req["cookies"]`, `req["headers"]`, `req["body"]`.
- The handler **returns** a map: `{"status": 200, "headers": {...}, "body": "..."}` (a bare
  body string works too; `status` defaults to 200, `Content-Type` to `text/html`).
- **Data** is Sprout's own `remember` / `recall` store (`sprout.data.json`, created next to
  `app.sprout` on first run and seeded with six products + the admin account).
- **The styling is Sprout too** — see Bloom below.

No CGI, no Python, no framework, not even hand-written CSS — the server, the backend, and the
styling are all Sprout.

## Styling with Bloom 🌸

The same way `serve()` means Sprout doesn't need Python to be a web server, **Bloom** means it
doesn't need hand-written CSS to have a look. Bloom is a tiny stylesheet language **written in
Sprout itself** (`bloom.sprout`, ~70 lines). You author `static/style.bloom`; Sprout compiles
it to CSS on the way out:

```bloom
make green  = #1f9d57          ~ name a value once, reuse it as {green}
make radius = 4px

.btn:                          ~ a rule is any line that ends with ":"
    background {green}
    border-radius {radius}
    padding 11px 22px

.btn:hover:                    ~ pseudo-classes? just write the whole selector
    background #127a41

screen below 820px:            ~ responsive -> @media (max-width: 820px)
    .grid:
        grid-template-columns 1fr
```

Indentation groups a rule's properties; `~` starts a comment; values pass through untouched
(so `var(--tint, #fff)`, gradients and `calc()` all just work). The handler turns it into CSS
with one call — `bloom.to_css(read("static/style.bloom"))` — and serves it as `text/css`.

That's the whole stack — Sprout all the way down.

## Requirements

Just the **Sprout interpreter** (v0.1.5+, which added `serve()`). Build it from the repo
root — `cd src && build.cmd` on Windows, or `cc -O2 -o sprout src/sprout.c -lm` on Linux/macOS
— or install it, then run `sprout run app.sprout` from this folder.

## This is a demo, not a production store

It's a *showcase of what you can build in Sprout*, so a few things are deliberately simple:

- **Auth is demo-grade.** Passwords use a small deterministic hash (not bcrypt/argon2) and
  session ids aren't cryptographically random. Don't reuse this auth for anything real.
- **One request at a time.** `serve()` handles requests sequentially, so the shared
  `sprout.data.json` is never raced — fine for a demo, not built for heavy load.
- **The data is a JSON file**, rewritten on each change.

Delete `sprout.data.json` any time to reset the shop to its seeded state.

## Files

| File | What it is |
| --- | --- |
| `app.sprout` | The whole store — server, auth, catalog, cart, orders, dashboard |
| `bloom.sprout` | **Bloom** — a tiny stylesheet language, written in Sprout (one task, `to_css`) |
| `static/style.bloom` | The store's styling, in Bloom (compiled to CSS at request time) |
| `sprout.data.json` | The database (created on first run; git-ignored) |
