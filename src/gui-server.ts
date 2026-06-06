// gui-server.ts — renders a Sprout GUI app in the browser and sends button
// clicks back to the running interpreter, so the app keeps its state.

import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { exec } from "node:child_process";

import { LangError, formatError } from "./errors.ts";
import type { Interpreter } from "./interpreter.ts";

export function startGuiServer(interp: Interpreter, opts: { open?: boolean } = {}): void {
  const PORT = Number(process.env.PORT ?? 4321);

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/state") {
      sendJson(res, { gui: interp.getGui() });
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
          /* ignore malformed body */
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

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`🌱 Your Sprout app is running at ${url}`);
    console.log("   It should open in your browser. Press Ctrl+C here to stop it.");
    if (opts.open) openBrowser(url);
  });
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

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Sprout App</title>
<style>
  :root {
    --bg:#0f1410; --card:#161d17; --ink:#e6efe6; --muted:#8aa08c;
    --green:#7bd88f; --green-dim:#4f9d63; --red:#ff7a85; --border:#28321f;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; min-height:100vh; background:var(--bg); color:var(--ink);
    font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
    display:flex; align-items:flex-start; justify-content:center;
  }
  .app {
    width:min(460px, 92vw); margin:48px 0; background:var(--card);
    border:1px solid var(--border); border-radius:16px; padding:28px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.4);
  }
  h1 { margin:0 0 20px; font-size:22px; }
  h1 .leaf { color:var(--green); }
  .widget { margin:14px 0; }
  .s-label { font-size:18px; line-height:1.5; }
  .s-button {
    font:inherit; font-weight:700; cursor:pointer; width:100%;
    background:var(--green); color:#08120a; border:0; border-radius:10px;
    padding:12px 16px;
  }
  .s-button:hover { background:#93e6a4; }
  .s-button:active { transform: translateY(1px); }
  .s-field {
    font:inherit; width:100%; background:var(--bg); color:var(--ink);
    border:1px solid var(--border); border-radius:10px; padding:12px 14px;
  }
  .s-field:focus { outline:none; border-color:var(--green-dim); }
  #error { color:var(--red); white-space:pre-wrap; font-family:ui-monospace,Consolas,monospace;
           font-size:13px; margin-top:18px; }
  .empty { color:var(--muted); }
</style>
</head>
<body>
  <div class="app">
    <h1><span class="leaf">🌱</span> <span id="title">Sprout App</span></h1>
    <div id="widgets"></div>
    <pre id="error"></pre>
  </div>
<script>
  async function load() {
    const r = await fetch("/state");
    render((await r.json()).gui);
  }
  function render(gui) {
    document.getElementById("title").textContent = gui.title;
    document.title = gui.title;
    const root = document.getElementById("widgets");
    root.innerHTML = "";
    if (!gui.widgets.length) {
      const e = document.createElement("div");
      e.className = "widget empty";
      e.textContent = "(This program didn't add any widgets yet. Try window(), label(), button().)";
      root.appendChild(e);
    }
    for (const w of gui.widgets) {
      const box = document.createElement("div");
      box.className = "widget";
      if (w.kind === "label") {
        const el = document.createElement("div");
        el.className = "s-label";
        el.textContent = w.text;
        box.appendChild(el);
      } else if (w.kind === "field") {
        const el = document.createElement("input");
        el.className = "s-field";
        el.placeholder = w.placeholder || "";
        el.value = w.text || "";
        el.dataset.fid = w.id;
        box.appendChild(el);
      } else if (w.kind === "button") {
        const el = document.createElement("button");
        el.className = "s-button";
        el.textContent = w.text;
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
    const r = await fetch("/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ button: task, fields: collectFields() }),
    });
    const d = await r.json();
    document.getElementById("error").textContent = d.error || "";
    render(d.gui);
  }
  load();
</script>
</body>
</html>`;
