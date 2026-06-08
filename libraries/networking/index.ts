// libraries/networking/index.ts — friendly network tools for Sprout.
//
//   use "networking"
//   show "This computer is", hostname()
//   show "On the network at", localip()
//   show "Public IP:", myip()
//   when online():
//       show "We're connected! 🌐"
//   show "google.com replied in", ping("google.com"), "ms"
//
// Sprout's interpreter is synchronous, so the network calls run in a short-lived
// Node subprocess (spawnSync) — exactly how the built-in get()/post() work, with
// no dependencies.

import { NONE, stringify } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";
import { hostname as osHostname, networkInterfaces } from "node:os";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Site = { line: number; col: number } | undefined;

function netError(msg: string, site: Site): LangError {
  return new LangError("Runtime", "Network problem: " + msg, site?.line ?? 1, site?.col ?? 1, "Check your internet connection and the address.");
}

// Run a tiny async Node script and return its stdout (throws a friendly error).
function runNode(script: string, args: string[], site: Site): string {
  const res = spawnSync(process.execPath, ["-e", script, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 20000,
  });
  if (res.error) throw netError(res.error.message, site);
  if (res.status !== 0) throw netError((res.stderr || "").trim() || "the request failed", site);
  return res.stdout ?? "";
}

// This computer's address on the local network (LAN), e.g. 192.168.1.20.
function localIp(): string {
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const net of ifs[name] ?? []) {
      if ((net.family === "IPv4" || (net.family as unknown) === 4) && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

// Strip "https://" and any path so "https://google.com/x" -> "google.com".
function bareHost(s: string): string {
  return s.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").trim();
}

export function create(interp: Interpreter) {
  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // The name of this computer.
    hostname: () => osHostname(),

    // This computer's address on your home/office network.
    localip: () => localIp(),

    // Your public IP — how the rest of the internet sees you.
    myip: (_args, site) =>
      runNode(
        "(async()=>{try{const r=await fetch('https://api.ipify.org');process.stdout.write((await r.text()).trim());}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
        [],
        site,
      ).trim(),

    // Are we online? online() checks the internet; online("https://site") checks one site. -> yes / no
    online: (args) => {
      const url = args[0] != null ? stringify(args[0]) : "https://www.google.com";
      const res = spawnSync(
        process.execPath,
        [
          "-e",
          "(async()=>{try{const r=await fetch(process.argv[1],{method:'HEAD'});process.stdout.write(r.status<500?'1':'0');}catch{process.stdout.write('0');}})()",
          url,
        ],
        { encoding: "utf8", timeout: 8000 },
      );
      return (res.stdout || "").trim() === "1";
    },

    // The HTTP status code of a web address (200 = OK, 404 = not found...). nothing if it can't connect.
    status: (args, site) => {
      const url = stringify(args[0] ?? NONE);
      const out = runNode(
        "(async()=>{try{const r=await fetch(process.argv[1]);process.stdout.write(String(r.status));}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
        [url],
        site,
      ).trim();
      const n = Number(out);
      return Number.isFinite(n) ? n : NONE;
    },

    // Round-trip time to a host in milliseconds (like a video-game ping). nothing if unreachable.
    ping: (args) => {
      const host = bareHost(stringify(args[0] ?? NONE));
      if (!host) return NONE;
      const isWin = process.platform === "win32";
      const cmdArgs = isWin ? ["-n", "1", "-w", "3000", host] : ["-c", "1", "-W", "3", host];
      const out = spawnSync("ping", cmdArgs, { encoding: "utf8", timeout: 6000 });
      const text = (out.stdout || "") + (out.stderr || "");
      const m = text.match(/time[=<]\s*(\d+(?:\.\d+)?)\s*ms/i);
      return m ? Number(m[1]) : NONE;
    },

    // Download a file from the web and save it next to your program. Returns the filename.
    download: (args, site) => {
      const url = stringify(args[0] ?? NONE);
      const name = stringify(args[1] ?? NONE);
      if (!name) throw new LangError("Runtime", "download needs a filename to save as.", site?.line ?? 1, site?.col ?? 1, 'Try: download("https://...", "picture.png")');
      const b64 = runNode(
        "(async()=>{try{const r=await fetch(process.argv[1]);if(!r.ok)throw new Error('the site replied with status '+r.status);const b=Buffer.from(await r.arrayBuffer());process.stdout.write(b.toString('base64'));}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
        [url],
        site,
      );
      writeFileSync(resolve(interp.programDir, name), Buffer.from(b64, "base64"));
      return name;
    },
  };

  return {
    names: ["hostname", "localip", "myip", "online", "status", "ping", "download"],
    builtins,
    isActive: () => false,
  };
}
