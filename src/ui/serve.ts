// serve.ts — runs a Sprout app as a website. Same widget model as the native
// GUI, same Bloom styling, but rendered in the browser and served over HTTP.
//
// This is Sprout's "server": a zero-dependency node:http server that renders
// the widgets and routes button clicks back to the live interpreter.

import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { exec } from "node:child_process";

import { LangError, formatError, formatMessage } from "../lang/errors.ts";
import { fontParts, styleFor, windowStyle } from "./bloom.ts";
import type { Style, Theme } from "./bloom.ts";
import type { Interpreter } from "../interp/interpreter.ts";

export function startWebServer(interp: Interpreter, theme: Theme, opts: { open?: boolean } = {}): void {
  const basePort = Number(process.env.PORT ?? 3000);

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/state") {
      sendJson(res, { gui: interp.getGui(), css: themeToCss(theme) });
      return;
    }
    if (req.method === "POST" && req.url === "/event") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let payload: { button?: string; fields?: Record<string, string> } = {};
        try {
          payload = JSON.parse(body);
        } catch {
          /* ignore */
        }
        if (payload.fields) interp.setFieldValues(payload.fields);
        let error: string | undefined;
        try {
          if (payload.button) interp.clickButton(String(payload.button));
        } catch (e) {
          error = e instanceof LangError ? formatError(e, interp.source) : e instanceof Error ? e.message : String(e);
        }
        sendJson(res, { gui: interp.getGui(), error });
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });

  listenWithRetry(server, basePort, 10, (port) => {
    const url = `http://localhost:${port}`;
    console.log(`🌱 Your Sprout site is running at ${url}`);
    console.log("   Press Ctrl+C here to stop it.");
    if (opts.open) openBrowser(url);
  });
}

function listenWithRetry(
  server: ReturnType<typeof createServer>,
  port: number,
  attemptsLeft: number,
  onReady: (port: number) => void,
): void {
  const onError = (err: NodeJS.ErrnoException) => {
    // Drop this attempt's success listener before trying the next port.
    server.removeListener("listening", onListening);
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      listenWithRetry(server, port + 1, attemptsLeft - 1, onReady);
    } else {
      console.error(
        "\n" +
          formatMessage(
            `I couldn't start the server on port ${port}.`,
            "Another app may be using it. Close it and try again, or set a different PORT.",
          ) +
          "\n",
      );
      process.exit(1);
    }
  };
  const onListening = () => {
    server.removeListener("error", onError);
    onReady(port);
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port);
}

function sendJson(res: ServerResponse, obj: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* if it fails, the user can open the link manually */
  });
}

// --- turn a Bloom theme into CSS ------------------------------------------

function styleToCss(style: Style): string {
  const decls: string[] = [];
  for (const [prop, value] of Object.entries(style)) {
    if (prop === "background") decls.push(`background:${value}`);
    else if (prop === "text") decls.push(`color:${value}`);
    else if (prop === "size") decls.push(`font-size:${value}px`);
    else if (prop === "border") decls.push(`border:1px solid ${value}`);
    else if (prop === "rounded") decls.push(`border-radius:${value}px`);
    else if (prop === "padding") decls.push(`padding:${value}px`);
    else if (prop === "width") decls.push(`width:${value}px`);
    else if (prop === "font") {
      const { family, size } = fontParts(value);
      decls.push(`font-family:${family}`);
      if (size) decls.push(`font-size:${size}px`);
    }
  }
  return decls.join(";");
}

function themeToCss(theme: Theme): string {
  const rules: string[] = [];
  const win = styleToCss(windowStyle(theme));
  if (win) rules.push(`body,.app{${win}}`);
  if (theme.selectors["label"]) rules.push(`.s-label{${styleToCss(theme.selectors["label"])}}`);
  if (theme.selectors["button"]) rules.push(`.s-button{${styleToCss(theme.selectors["button"])}}`);
  if (theme.selectors["field"]) rules.push(`.s-field{${styleToCss(theme.selectors["field"])}}`);
  // Per-id overrides (selectors that start with '#').
  for (const [name, style] of Object.entries(theme.selectors)) {
    if (name.startsWith("#")) rules.push(`[data-wid="${name.slice(1)}"]{${styleToCss(style)}}`);
  }
  return rules.join("\n");
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Sprout App</title>
<style>
  /* Raw, minimal layout only — Bloom adds all the design. (Like HTML with no CSS.) */
  body { margin:0; padding:24px; font-family: system-ui, sans-serif; }
  .app { max-width:560px; margin:0 auto; }
  .widget { margin:10px 0; }
  .s-label { display:block; }
  .s-button { font:inherit; padding:6px 12px; cursor:pointer; }
  .s-field { font:inherit; padding:6px; }
  #error { color:#b00020; white-space:pre-wrap; font-family:monospace; margin-top:16px; }
</style>
<style id="theme"></style>
</head>
<body>
  <div class="app">
    <h1 id="title">Sprout App</h1>
    <div id="widgets"></div>
    <pre id="error"></pre>
  </div>
<script>
  async function load() {
    const d = await (await fetch("/state")).json();
    if (d.css) document.getElementById("theme").textContent = d.css;
    render(d.gui);
  }
  function render(gui) {
    document.getElementById("title").textContent = gui.title;
    document.title = gui.title;
    const root = document.getElementById("widgets");
    root.innerHTML = "";
    for (const w of gui.widgets) {
      const box = document.createElement("div");
      box.className = "widget";
      box.dataset.wid = w.id;
      if (w.kind === "label") {
        const el = document.createElement("div");
        el.className = "s-label"; el.textContent = w.text; el.dataset.wid = w.id;
        box.appendChild(el);
      } else if (w.kind === "field") {
        const el = document.createElement("input");
        el.className = "s-field"; el.placeholder = w.placeholder || ""; el.value = w.text || "";
        el.dataset.fid = w.id; el.dataset.wid = w.id;
        box.appendChild(el);
      } else if (w.kind === "button") {
        const el = document.createElement("button");
        el.className = "s-button"; el.textContent = w.text; el.dataset.wid = w.id;
        el.onclick = () => click(w.onClick);
        box.appendChild(el);
      }
      root.appendChild(box);
    }
  }
  function collectFields() {
    const fields = {};
    document.querySelectorAll("[data-fid]").forEach((i) => (fields[i.dataset.fid] = i.value));
    return fields;
  }
  async function click(task) {
    const d = await (await fetch("/event", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ button: task, fields: collectFields() }),
    })).json();
    document.getElementById("error").textContent = d.error || "";
    render(d.gui);
  }
  load();
</script>
</body>
</html>`;
