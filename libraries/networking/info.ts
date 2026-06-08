// libraries/networking/info.ts — network info & diagnostics for Sprout.
//
//   use "networking/info"
//   show "This computer is", hostname()
//   show "On the LAN at", localip(), "(", macaddress(), ")"
//   show "Public IP:", myip()
//   when online():
//       show "We're connected! 🌐"
//   show "google.com replied in", ping("google.com"), "ms"
//   set place to whereis(myip())
//   show "You appear to be in", place["city"]
//
// Sprout's interpreter is SYNCHRONOUS, so every network call here runs in a
// short-lived Node subprocess (spawnSync) and we wait for the answer — exactly
// how the built-in get()/post() work, with zero dependencies.

import { NONE, stringify, SList, SMap } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";
import { hostname as osHostname, networkInterfaces } from "node:os";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Site = { line: number; col: number } | undefined;

export function register(interp: Interpreter) {
  // --- helpers ---------------------------------------------------------------

  // Turn a raw Node/system error into Sprout's friendly voice.
  function netError(msg: string, site: Site): LangError {
    return new LangError("Runtime", "Network problem: " + msg, site?.line ?? 1, site?.col ?? 1, "Check your internet connection and the address.");
  }

  // Run a tiny async Node script and return its stdout (throws a friendly error).
  // In the -e script the FIRST passed arg is process.argv[1] (not [0]).
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

  // Find the first non-internal IPv4 interface — that's "this computer on the LAN".
  // Returns the whole interface record so callers can read .address or .mac.
  function firstIpv4(): { address: string; mac: string } | undefined {
    const ifs = networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const net of ifs[name] ?? []) {
        if ((net.family === "IPv4" || (net.family as unknown) === 4) && !net.internal) {
          return { address: net.address, mac: net.mac };
        }
      }
    }
    return undefined;
  }

  // Strip "https://" and any path so "https://google.com/x" -> "google.com".
  function bareHost(s: string): string {
    return s.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").trim();
  }

  // --- the built-in functions ------------------------------------------------

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // The name of this computer.
    hostname: () => osHostname(),

    // This computer's address on your home/office network, e.g. 192.168.1.20.
    localip: () => firstIpv4()?.address ?? "127.0.0.1",

    // The hardware (MAC) address of your main network card, e.g. A1-B2-C3-D4-E5-F6.
    macaddress: () => {
      const iface = firstIpv4();
      const raw = iface?.mac;
      // Normalize to UPPERCASE hyphen form; skip the all-zero placeholder.
      if (raw && raw !== "00:00:00:00:00:00") return raw.replace(/:/g, "-").toUpperCase();
      // Fallback: ask Windows for the MAC of the first physical adapter.
      if (process.platform === "win32") {
        const res = spawnSync("getmac", ["/fo", "csv", "/nh"], { encoding: "utf8", timeout: 8000 });
        const m = (res.stdout || "").match(/([0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5})/);
        if (m) return m[1].toUpperCase();
      }
      return "00-00-00-00-00-00";
    },

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
          "(async()=>{try{const r=await fetch(process.argv[1]||'https://www.google.com',{method:'HEAD'});process.stdout.write(r.status<500?'1':'0');}catch{process.stdout.write('0');}})()",
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

    // Is a particular port open on a host? Great for checking servers. -> yes / no
    // (e.g. isopen("example.com", 443) — is the website's secure port reachable?)
    isopen: (args, site) => {
      const host = bareHost(stringify(args[0] ?? NONE));
      const port = stringify(args[1] ?? NONE);
      if (!host || !port) return false;
      const out = runNode(
        "const net=require('node:net');const done=(v)=>{process.stdout.write(v);process.exit(0)};const s=net.connect(Number(process.argv[2]),process.argv[1]);s.once('connect',()=>{s.destroy();done('1')});s.once('error',()=>done('0'));setTimeout(()=>{try{s.destroy()}catch(e){}done('0')},3000);",
        [host, port],
        site,
      );
      return out.trim() === "1";
    },

    // Trace the path your data takes to a host: a list of the routers it hops through.
    hops: (args, site) => {
      const host = bareHost(stringify(args[0] ?? NONE));
      if (!host) return new SList([]);
      const isWin = process.platform === "win32";
      const res = isWin
        ? spawnSync("tracert", ["-d", "-h", "15", "-w", "800", host], { encoding: "utf8", timeout: 20000 })
        : spawnSync("traceroute", ["-n", "-m", "15", "-w", "1", host], { encoding: "utf8", timeout: 20000 });
      const text = (res.stdout || "") + "\n" + (res.stderr || "");
      const routers: Value[] = [];
      for (const line of text.split(/\r?\n/)) {
        // Skip header/footer lines; take the FIRST IPv4 address on each hop line.
        const ip = line.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
        if (ip && !line.includes("*")) routers.push(ip[1]);
      }
      return new SList(routers);
    },

    // The name of the Wi-Fi network you're connected to (the SSID). nothing if not on Wi-Fi.
    wifi: (_args, site) => {
      if (process.platform !== "win32") throw new LangError("Runtime", "wifi() works on Windows.", site?.line ?? 1, site?.col ?? 1, "On other systems, check your Wi-Fi from the system menu.");
      const res = spawnSync("netsh", ["wlan", "show", "interfaces"], { encoding: "utf8", timeout: 8000 });
      // Match SSID but NOT BSSID (the access point's hardware address).
      const m = (res.stdout || "").match(/^\s*SSID\s*:\s*(.+)$/m);
      const ssid = m ? m[1].trim() : "";
      return ssid ? ssid : NONE;
    },

    // How strong your Wi-Fi is, as a percent (100 = excellent). nothing if not on Wi-Fi.
    wifisignal: (_args, site) => {
      if (process.platform !== "win32") throw new LangError("Runtime", "wifisignal() works on Windows.", site?.line ?? 1, site?.col ?? 1, "On other systems, check your Wi-Fi from the system menu.");
      const res = spawnSync("netsh", ["wlan", "show", "interfaces"], { encoding: "utf8", timeout: 8000 });
      const m = (res.stdout || "").match(/Signal\s*:\s*(\d+)%/);
      return m ? Number(m[1]) : NONE;
    },

    // Roughly where an IP address is in the world. Returns a map you can index:
    //   set place to whereis("8.8.8.8")
    //   show place["city"], place["country"]
    // nothing's looked up returns NONE if the service is unreachable.
    whereis: (args, site) => {
      const x = encodeURIComponent(stringify(args[0] ?? NONE).trim());
      const out = runNode(
        "(async()=>{try{const r=await fetch('http://ip-api.com/json/'+process.argv[1]+'?fields=status,country,regionName,city,isp,lat,lon,query');process.stdout.write(await r.text());}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
        [x],
        site,
      ).trim();
      try {
        const j = JSON.parse(out) as Record<string, unknown>;
        if (j.status !== "success") return NONE;
        const entries = new Map<string, Value>();
        entries.set("city", typeof j.city === "string" ? j.city : "");
        entries.set("region", typeof j.regionName === "string" ? j.regionName : "");
        entries.set("country", typeof j.country === "string" ? j.country : "");
        entries.set("isp", typeof j.isp === "string" ? j.isp : "");
        entries.set("lat", typeof j.lat === "number" ? j.lat : NONE);
        entries.set("lon", typeof j.lon === "number" ? j.lon : NONE);
        return new SMap(entries);
      } catch {
        return NONE;
      }
    },

    // Measure your download speed in megabits per second (Mbps) by fetching ~25 MB.
    speedtest: (_args, site) => {
      const out = runNode(
        "(async()=>{try{const{performance}=require('node:perf_hooks');const t0=performance.now();const r=await fetch('https://speed.cloudflare.com/__down?bytes=25000000');const b=await r.arrayBuffer();const secs=(performance.now()-t0)/1000;const mbps=b.byteLength*8/secs/1e6;process.stdout.write(String(Math.round(mbps*10)/10));}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
        [],
        site,
      ).trim();
      const n = Number(out);
      return Number.isFinite(n) ? n : NONE;
    },

    // Who owns a domain, and when it was registered / expires. Returns a map:
    //   set info to whois("example.com")
    //   show info["registrar"], info["expires"]
    // nothing if the lookup fails (it's best-effort).
    whois: (args, site) => {
      const domain = bareHost(stringify(args[0] ?? NONE)).toLowerCase();
      if (!domain) return NONE;
      let out: string;
      try {
        out = runNode(
          "(async()=>{try{const r=await fetch('https://rdap.org/domain/'+process.argv[1]);if(!r.ok)throw new Error('status '+r.status);process.stdout.write(await r.text());}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
          [encodeURIComponent(domain)],
          site,
        ).trim();
      } catch {
        return NONE;
      }
      try {
        const j = JSON.parse(out) as Record<string, unknown>;
        // Registrar: the entity whose roles include "registrar"; use its name (vCard fn).
        let registrar = "";
        const entities = Array.isArray(j.entities) ? (j.entities as Array<Record<string, unknown>>) : [];
        for (const ent of entities) {
          const roles = Array.isArray(ent.roles) ? (ent.roles as unknown[]).map(String) : [];
          if (!roles.includes("registrar")) continue;
          const vcard = Array.isArray(ent.vcardArray) ? (ent.vcardArray as unknown[])[1] : undefined;
          if (Array.isArray(vcard)) {
            for (const field of vcard as unknown[][]) {
              if (Array.isArray(field) && field[0] === "fn" && typeof field[3] === "string") { registrar = field[3]; break; }
            }
          }
          if (registrar) break;
        }
        // Created / expires: from the events list, by eventAction.
        let created = "";
        let expires = "";
        const events = Array.isArray(j.events) ? (j.events as Array<Record<string, unknown>>) : [];
        for (const ev of events) {
          const action = typeof ev.eventAction === "string" ? ev.eventAction : "";
          const date = typeof ev.eventDate === "string" ? ev.eventDate : "";
          if (action === "registration") created = date;
          else if (action === "expiration") expires = date;
        }
        const entries = new Map<string, Value>();
        entries.set("registrar", registrar);
        entries.set("created", created);
        entries.set("expires", expires);
        return new SMap(entries);
      } catch {
        return NONE;
      }
    },
  };

  return {
    names: [
      "hostname",
      "localip",
      "macaddress",
      "myip",
      "online",
      "status",
      "ping",
      "download",
      "isopen",
      "hops",
      "wifi",
      "wifisignal",
      "whereis",
      "speedtest",
      "whois",
    ],
    builtins,
    isActive: () => false,
  };
}
