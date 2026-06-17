# 🛒 Sprout Store — a web app written **entirely** in Sprout

A small but complete e-commerce site — **no other language, no external server.** Sprout
serves the HTTP itself with the built-in `serve()` function. It has:

- **A storefront** — browse a product catalog, view product pages.
- **Accounts & auth** — register, log in / out, cookie sessions, password hashing.
- **A cart & checkout** — add items, see your cart total, place an order (stock decrements).
- **Your orders** — every order you've placed.
- **An admin dashboard** — revenue / order / product / customer stats, recent orders, and a
  form to add new products. Gated to admins only.
- **Pages written in Sprout, not HTML** — every view returns native Sprout data (nested
  lists + maps); `view.sprout` renders it to HTML. You never concatenate tags by hand.

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
use "view.sprout"

task handle(req):
    when req["path"] == "/":
        give {"status": 200, "body": view.render(
            ["h1", {}, "Hello from Sprout"]      ~ Sprout data — rendered to HTML
        )}
    give {"status": 404, "body": "not found"}

serve(8090, handle)
```

- **`req`** is a map: `req["method"]`, `req["path"]`, `req["params"]` (query + form fields),
  `req["cookies"]`, `req["headers"]`, `req["body"]`.
- The handler **returns** a map: `{"status": 200, "headers": {...}, "body": "..."}` (a bare
  body string works too; `status` defaults to 200, `Content-Type` to `text/html`).
- **Data** is Sprout's own `remember` / `recall` store (`sprout.data.json`, created next to
  `app.sprout` on first run and seeded with six products + the admin account).
- The CSS is served by the handler reading `static/style.css` with `read()`.

That's the whole stack — Sprout files only. No CGI, no Python, no framework.

## The pages are Sprout data, not HTML

The store never builds HTML by gluing strings together. A page is described with native
Sprout values, and `view.sprout`'s `render` turns that tree into HTML:

```sprout
~ an element is a list shaped [tag, attrs-map, ...children]
["a", {"class": "btn", "href": "/cart"}, "View cart"]
~ ->  <a class="btn" href="/cart">View cart</a>
```

- **Text is escaped automatically.** A string child is HTML-escaped, so `"Tom & Jerry"`
  renders as `Tom &amp; Jerry` — no XSS from user input, no manual `&amp;`.
- **Lists splice in**, which makes loops trivial:

```sprout
make rows = []
for each pr in products:
    add(rows, ["li", {}, pr["name"]])
give ["ul", {}, rows]          ~ a list child is rendered item by item
```

- **Boolean attributes** read naturally: `{"required": yes}` → `required`,
  `{"hidden": no}` → omitted. **Void tags** (`input`, `br`, `img`, …) self-close.
- Need raw HTML you already have? `view.raw("<svg>…</svg>")` drops it in unescaped.

So a "template" is just a Sprout task that returns a list. `chrome()`, `product_card()`,
`view_dashboard()` and the rest are all ordinary Sprout building ordinary Sprout data.

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
| `view.sprout` | The view layer — `render` turns Sprout data (lists/maps) into HTML |
| `static/style.css` | Styling |
| `sprout.data.json` | The database (created on first run; git-ignored) |
