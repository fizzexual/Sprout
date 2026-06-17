# 🛒 Sprout Store — a real web app written in Sprout

A small but complete e-commerce site whose **entire backend is written in
[Sprout](https://github.com/fizzexual/Sprout)** — the from-scratch language. It has:

- **A storefront** — browse a product catalog, view product pages.
- **Accounts & auth** — register, log in / out, cookie sessions, password hashing.
- **A cart & checkout** — add items, see your cart total, place an order (stock decrements).
- **Your orders** — every order you've placed.
- **An admin dashboard** — revenue / order / product / customer stats, recent orders, and a
  form to add new products. Gated to admins only.

```
$ cd store
$ python server.py
Sprout store running on  http://localhost:8090
```

Open **http://localhost:8090**, register an account, shop — and log in as the seeded admin
(`admin` / `admin`) to see the dashboard.

## How it works (and why there's a Python file)

Sprout doesn't have a built-in HTTP server yet (it's on the roadmap). So — exactly like
**CGI** or classic **PHP** — a tiny, *app-agnostic* host speaks HTTP, and **all the actual
store logic lives in Sprout**:

```
  browser ──HTTP──▶  server.py  ──stdin──▶  app.sprout  ──remember/recall──▶  sprout.data.json
          ◀─HTML───  (≈170 lines,   ◀─stdout──  (the whole store:            (the "database")
                      generic glue)              auth, cart, orders, …)
```

- **`server.py`** is ~170 lines and knows *nothing* about shops. For each request it writes
  the method / path / cookies / form fields to Sprout's stdin as simple `key⇥value` lines,
  runs `sprout run app.sprout`, and turns Sprout's printed response back into HTTP.
- **`app.sprout`** is the application — routing, sessions, the catalog, the cart, orders, the
  dashboard, and every HTML page. ~400 lines of Sprout.
- **The database** is Sprout's own `remember` / `recall` store (`sprout.data.json`), created
  next to `app.sprout` on first run and seeded with six products + the admin account.

That split is the honest, interesting part: it shows you can write a real web application's
*logic* in Sprout today, using a host only for the HTTP plumbing.

## Requirements

- **Python 3** (standard library only — no pip installs) for the host.
- **The Sprout interpreter.** By default the host looks for `../src/sprout.exe` (or
  `../src/sprout`); build it with `cc -O2 -o src/sprout src/sprout.c -lm` (or `gcc … -lurlmon`
  on Windows). Or point it anywhere: `SPROUT_BIN=/path/to/sprout python server.py`.
- Change the port with `PORT=9000 python server.py`.

## This is a demo, not a production store

It's a *showcase of what you can build in Sprout*, so a few things are deliberately simple:

- **Auth is demo-grade.** Passwords use a small deterministic hash (not bcrypt/argon2) and
  session ids aren't cryptographically random. Don't reuse this auth for anything real.
- **One request at a time.** The host serializes requests so the shared `sprout.data.json`
  isn't raced — fine for a demo, not built for load.
- **The data is a JSON file**, rewritten on each change.

Delete `sprout.data.json` any time to reset the shop to its seeded state.

## Files

| File | What it is |
| --- | --- |
| `app.sprout` | The whole store, written in Sprout |
| `server.py` | Generic HTTP ↔ Sprout host (CGI-style) |
| `static/style.css` | Styling |
| `sprout.data.json` | The database (created on first run; git-ignored) |
