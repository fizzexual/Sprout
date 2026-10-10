# Small apps with Sprout

`lib/ui.sprout` generates styled HTML with escaped text, headings, paragraphs,
links, buttons, labeled inputs, forms, cards, metrics, responsive columns, and
tables. This first toolkit exports local browser apps. JavaScript implements
browser interactions; Sprout prepares data and renders the document.

## Try the finished order report

From the repository root, using the current interpreter:

```sh
sprout run examples/apps/dashboard.sprout
```

Open `sprout-dashboard.html` in a browser. Search filters rows immediately;
column buttons sort ascending/descending; **Download filtered CSV** exports the
currently visible rows. All styles and JavaScript are embedded, so the exported
report runs offline and can be shared as one HTML file.

Supply a CSV path and output filename to use your data:

```sh
sprout run examples/apps/dashboard.sprout my-orders.csv my-report.html
```

CSV columns are `Order,Customer,Item,Amount,Status`. Amounts use exact decimals,
and quoted CSV fields can contain commas, quotes, or HTML-looking text. Data is
escaped before rendering. CSV export prefixes potential spreadsheet formulas.

## Compose a page

```sprout
use "lib/ui.sprout"
use files
make body = ui.heading("Hello") + ui.paragraph("<This is displayed as text>")
set body += ui.card("Contact", ui.form("/contact", ui.input("Your email", "email", "", "email")))
make saved = files.write("hello.html", ui.page("Hello", body))
when not saved["ok"]:
    fail saved["error"]
```

Run trusted module-based apps without `--sandbox`: the sandbox prevents loading
local modules and writing files. Check I/O result maps before consuming their
payloads. Native server adapters and desktop windows are separate integrations;
the toolkit itself does not start a server or access the browser DOM.

## API and boundaries

| Function | Inputs |
| --- | --- |
| `ui.escape(value)` | Escape a value as HTML text or an attribute value. |
| `ui.heading(text, level = 1)` | Escaped heading text; level 1–6. |
| `ui.paragraph(text)` | Escaped paragraph text. |
| `ui.button(text, id = "")` | An escaped label and ID; type is `button`. |
| `ui.link(text, url)` | Escaped label; relative or HTTP(S) URL. |
| `ui.input(label, name, value = "", kind = "text")` | Labeled field; supported types are text/search/email/number/date/password/checkbox. |
| `ui.form(action, content)` | GET form containing rendered fragments. |
| `ui.card(title, content)` | Titled section containing rendered fragments. |
| `ui.metric(label, value)` | Escaped metric label and value. |
| `ui.columns(fragments)` | List of rendered fragments in a responsive grid. |
| `ui.table(headers, rows, id = "report")` | Escaped headers and a list of escaped rows. |
| `ui.page(title, content, script = "")` | Complete page; content is rendered HTML and script is trusted JavaScript. |

The distinction between **text** and **rendered content** matters. Pass untrusted
values through text helpers or `ui.escape`; never concatenate them directly into
content or script. IDs are escaped, but callers must choose unique IDs. Scripts
must be trusted application source; `ui.page` does not sanitize JavaScript.

## Distribution

The HTML output is already self-contained. The generator is a multi-file project:
bundle `dashboard.sprout` with its `lib/ui.sprout` import and the CSV/JavaScript
assets using the current project bundle command. The standalone generator still
needs permission to write its output. Asset paths are relative to the project
directory, matching normal Sprout execution.
