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

import { NONE, stringify, SList } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";
import { hostname as osHostname, networkInterfaces } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Site = { line: number; col: number } | undefined;

// --- website blocking (via the system "hosts" file) ---------------------------
// Blocking a site means adding a line that points its name at 127.0.0.1 (this
// computer), so it never reaches the real server. We tag our lines so unblock /
// blocked only ever touch what Sprout added — never the user's own hosts entries.
const HOSTS = process.platform === "win32"
  ? (process.env.SystemRoot || "C:\\Windows") + "\\System32\\drivers\\etc\\hosts"
  : "/etc/hosts";
const TAG = "# sprout-block";
const NL = process.platform === "win32" ? "\r\n" : "\n";

function readHosts(): string {
  try { return readFileSync(HOSTS, "utf8"); } catch { return ""; }
}

function flushDns(): void {
  try { if (process.platform === "win32") spawnSync("ipconfig", ["/flushdns"], { stdio: "ignore", timeout: 5000 }); } catch { /* best effort */ }
}

function writeHosts(text: string, site: Site): void {
  try { writeFileSync(HOSTS, text); }
  catch (e) {
    const code = (e && typeof e === "object" && "code" in e) ? String((e as { code: unknown }).code) : "";
    if (code === "EPERM" || code === "EACCES") {
      throw new LangError("Runtime", "Blocking a website needs administrator rights.", site?.line ?? 1, site?.col ?? 1,
        process.platform === "win32"
          ? "Close this, right-click your terminal (or VS Code), choose 'Run as administrator', and run your program again."
          : "Run your program with sudo to edit the hosts file.");
    }
    throw netError(e instanceof Error ? e.message : String(e), site);
  }
  flushDns();
}

// "https://www.Example.com/page" -> "example.com"
function cleanDomain(s: string): string {
  return s.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./i, "").trim().toLowerCase();
}

// Does a hosts line block this exact domain (apex or www)? (only our tagged lines)
function lineBlocks(line: string, domain: string): boolean {
  return line.includes(TAG) && (line.includes(" " + domain + " ") || line.includes(" www." + domain + " "));
}

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

    // Block a website on THIS computer — it won't load in any browser. Needs admin.
    block: (args, site) => {
      const domain = cleanDomain(stringify(args[0] ?? NONE));
      if (!domain) throw new LangError("Runtime", "block needs a website address.", site?.line ?? 1, site?.col ?? 1, 'Try: block("example.com")');
      const kept = readHosts().split(/\r?\n/).filter((l) => !lineBlocks(l, domain));
      while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
      kept.push("127.0.0.1 " + domain + " " + TAG);
      kept.push("127.0.0.1 www." + domain + " " + TAG);
      writeHosts(kept.join(NL) + NL, site);
      return NONE;
    },

    // Unblock a website you blocked earlier. Needs admin.
    unblock: (args, site) => {
      const domain = cleanDomain(stringify(args[0] ?? NONE));
      if (!domain) throw new LangError("Runtime", "unblock needs a website address.", site?.line ?? 1, site?.col ?? 1, 'Try: unblock("example.com")');
      const kept = readHosts().split(/\r?\n/).filter((l) => !lineBlocks(l, domain));
      writeHosts(kept.join(NL), site);
      return NONE;
    },

    // Is a website blocked on this computer right now? -> yes / no
    isblocked: (args) => {
      const domain = cleanDomain(stringify(args[0] ?? NONE));
      return domain ? readHosts().split(/\r?\n/).some((l) => lineBlocks(l, domain)) : false;
    },

    // A list of the websites you've blocked.
    blocked: () => {
      const found = new Set<string>();
      for (const l of readHosts().split(/\r?\n/)) {
        if (!l.includes(TAG)) continue;
        const m = l.match(/^\s*\S+\s+(\S+)/);
        if (m) found.add(m[1].replace(/^www\./i, ""));
      }
      return new SList([...found]);
    },
  };

  return {
    names: ["hostname", "localip", "myip", "online", "status", "ping", "download", "block", "unblock", "isblocked", "blocked"],
    builtins,
    isActive: () => false,
  };
}
