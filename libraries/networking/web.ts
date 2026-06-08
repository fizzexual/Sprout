// libraries/networking/web.ts — handy web & data lookups for Sprout.
//
//   use "networking/web"
//   show weather("London")                 ~ "London: 🌤  +16°C"
//   show mac_vendor("A4-83-E7-00-00-00")   ~ the company that made a network card
//   show ssl_expiry("github.com"), "days"  ~ when a site's HTTPS certificate runs out
//   set c to cert("github.com")
//   show c["issuer"], "until", c["expires"]
//   for each ip in dns("example.com"):     ~ the addresses behind a name
//       show ip
//   set h to headers("https://example.com")
//   show h["content-type"]
//   show shorten("https://a-very-long-url.example.com/page")
//   show expand("https://bit.ly/xyz")      ~ where a short link really goes
//   show filesize("https://example.com/big.zip"), "MB"
//
// Sprout's interpreter is SYNCHRONOUS, so every lookup here runs in a
// short-lived Node subprocess (spawnSync) and we wait for the answer — exactly
// how the built-in get()/post() work, with zero dependencies.

import { NONE, stringify, SList, SMap } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";

type Site = { line: number; col: number } | undefined;

// A plain-text marker the helper subprocesses print to say "there's nothing here"
// (e.g. a 404 or a missing header). It has no spaces, so it survives .trim().
const NONE_MARK = "__SPROUT_NONE__";

export function register(_interp: Interpreter) {
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

  // Strip "https://" and any path so "https://google.com/x" -> "google.com".
  function bareHost(s: string): string {
    return s.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").trim();
  }

  // --- the built-in functions ------------------------------------------------

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // ~ The current weather for a city, as a short line like "London: 🌤  +16°C". nothing if it can't be found.
    weather: (args, site) => {
      const city = stringify(args[0] ?? NONE).trim();
      if (!city) return NONE;
      const out = runNode(
        "(async()=>{try{const r=await fetch('https://wttr.in/'+encodeURIComponent(process.argv[1])+'?format=3');if(!r.ok)throw new Error('status '+r.status);process.stdout.write((await r.text()).trim());}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
        [city],
        site,
      ).trim();
      return out ? out : NONE;
    },

    // ~ The company that made a network card, from its MAC address. nothing if unknown.
    mac_vendor: (args, site) => {
      const mac = stringify(args[0] ?? NONE).trim();
      if (!mac) return NONE;
      // On a 404 the subprocess prints our marker, so a "not found" becomes nothing instead of an error.
      const out = runNode(
        "(async()=>{try{const r=await fetch('https://api.macvendors.com/'+encodeURIComponent(process.argv[1]));if(r.status===404){process.stdout.write(process.argv[2]);return;}const t=(await r.text()).trim();process.stdout.write(t);}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
        [mac, NONE_MARK],
        site,
      ).trim();
      if (out === NONE_MARK || out.includes("Not Found") || !out) return NONE;
      return out;
    },

    // ~ How many days until a website's HTTPS certificate expires. nothing if it can't be checked.
    ssl_expiry: (args, site) => {
      const host = bareHost(stringify(args[0] ?? NONE));
      const port = typeof args[1] === "number" ? args[1] : 443;
      if (!host) return NONE;
      const out = runNode(
        "const tls=require('node:tls');let open=true;const done=(v)=>{if(!open)return;open=false;process.stdout.write(v);process.exit(0)};" +
          "const s=tls.connect(Number(process.argv[2]),{host:process.argv[1],servername:process.argv[1]},()=>{try{const c=s.getPeerCertificate();const ms=Date.parse(c.valid_to);const days=Math.ceil((ms-Date.now())/86400000);s.destroy();done(String(days));}catch(e){try{s.destroy()}catch(_){}done('')}});" +
          "s.once('error',()=>done(''));setTimeout(()=>{try{s.destroy()}catch(e){}done('')},5000);",
        [host, String(port)],
        site,
      ).trim();
      const n = Number(out);
      return out !== "" && Number.isFinite(n) ? n : NONE;
    },

    // ~ Details about a website's HTTPS certificate: who issued it, what it covers, and when it expires.
    //   set c to cert("github.com")  /  show c["issuer"], c["expires"], c["days"], c["valid"]
    cert: (args, site) => {
      const host = bareHost(stringify(args[0] ?? NONE));
      if (!host) return NONE;
      const out = runNode(
        "const tls=require('node:tls');let open=true;const done=(v)=>{if(!open)return;open=false;process.stdout.write(v);process.exit(0)};" +
          "const s=tls.connect(443,{host:process.argv[1],servername:process.argv[1]},()=>{try{const c=s.getPeerCertificate();s.destroy();" +
          "const issuer=(c.issuer&&c.issuer.O)||'';const subject=(c.subject&&c.subject.CN)||'';const ms=Date.parse(c.valid_to);" +
          "const out={issuer:issuer,subject:subject,expires:isNaN(ms)?'':new Date(ms).toISOString(),days:isNaN(ms)?null:Math.ceil((ms-Date.now())/86400000),valid:(!isNaN(ms)&&ms>Date.now())?'yes':'no'};" +
          "done(JSON.stringify(out));}catch(e){try{s.destroy()}catch(_){}done('')}});" +
          "s.once('error',()=>done(''));setTimeout(()=>{try{s.destroy()}catch(e){}done('')},5000);",
        [host],
        site,
      ).trim();
      if (!out) return NONE;
      try {
        const j = JSON.parse(out) as Record<string, unknown>;
        const entries = new Map<string, Value>();
        entries.set("issuer", typeof j.issuer === "string" ? j.issuer : "");
        entries.set("subject", typeof j.subject === "string" ? j.subject : "");
        entries.set("expires", typeof j.expires === "string" ? j.expires : "");
        entries.set("days", typeof j.days === "number" ? j.days : NONE);
        entries.set("valid", j.valid === "yes" ? "yes" : "no");
        return new SMap(entries);
      } catch {
        return NONE;
      }
    },

    // ~ The addresses a domain name points to (a DNS lookup). dns(name) does "A" records; pass a type like "MX" or "TXT".
    //   for each ip in dns("example.com"): show ip
    dns: (args, site) => {
      const name = bareHost(stringify(args[0] ?? NONE));
      const type = (args[1] != null ? stringify(args[1]) : "A").trim().toUpperCase() || "A";
      if (!name) return new SList([]);
      const out = runNode(
        "(async()=>{try{const r=await fetch('https://dns.google/resolve?name='+encodeURIComponent(process.argv[1])+'&type='+encodeURIComponent(process.argv[2]));process.stdout.write(await r.text());}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
        [name, type],
        site,
      ).trim();
      try {
        const j = JSON.parse(out) as { Answer?: Array<{ data?: unknown }> };
        const answers = Array.isArray(j.Answer) ? j.Answer : [];
        const items: Value[] = [];
        for (const a of answers) {
          if (typeof a.data === "string") items.push(a.data);
        }
        return new SList(items);
      } catch {
        return new SList([]);
      }
    },

    // ~ The HTTP headers a web address sends back, as a map you can index.
    //   set h to headers("https://example.com")  /  show h["content-type"]
    headers: (args, site) => {
      const url = stringify(args[0] ?? NONE).trim();
      if (!url) return new SMap();
      const out = runNode(
        "(async()=>{try{let r=await fetch(process.argv[1],{method:'HEAD',redirect:'follow'});" +
          "if(r.status===405){r=await fetch(process.argv[1],{method:'GET',redirect:'follow'});}" +
          "const o={};for(const[k,v]of r.headers.entries())o[k]=v;process.stdout.write(JSON.stringify(o));}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
        [url],
        site,
      ).trim();
      try {
        const j = JSON.parse(out) as Record<string, unknown>;
        const entries = new Map<string, Value>();
        for (const k of Object.keys(j)) entries.set(k, typeof j[k] === "string" ? (j[k] as string) : String(j[k]));
        return new SMap(entries);
      } catch {
        return new SMap();
      }
    },

    // ~ Make a long web address into a short one (via is.gd). nothing if it couldn't be shortened.
    shorten: (args, site) => {
      const url = stringify(args[0] ?? NONE).trim();
      if (!url) return NONE;
      const out = runNode(
        "(async()=>{try{const r=await fetch('https://is.gd/create.php?format=simple&url='+encodeURIComponent(process.argv[1]));process.stdout.write((await r.text()).trim());}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
        [url],
        site,
      ).trim();
      if (!out || out.startsWith("Error") || !/^https?:\/\//i.test(out)) return NONE;
      return out;
    },

    // ~ Follow a short link to where it really goes, and give back the final web address.
    expand: (args, site) => {
      const url = stringify(args[0] ?? NONE).trim();
      if (!url) return NONE;
      const out = runNode(
        "(async()=>{try{const r=await fetch(process.argv[1],{redirect:'follow'});process.stdout.write(r.url);}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
        [url],
        site,
      ).trim();
      return out ? out : NONE;
    },

    // ~ How big a download is, in megabytes (MB), without downloading it. nothing if the server won't say.
    filesize: (args, site) => {
      const url = stringify(args[0] ?? NONE).trim();
      if (!url) return NONE;
      // When the content-length header is missing, the subprocess prints our marker -> nothing.
      const out = runNode(
        "(async()=>{try{const r=await fetch(process.argv[1],{method:'HEAD',redirect:'follow'});const len=r.headers.get('content-length');if(len==null){process.stdout.write(process.argv[2]);return;}process.stdout.write(len);}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
        [url, NONE_MARK],
        site,
      ).trim();
      if (out === NONE_MARK || out === "") return NONE;
      const bytes = Number(out);
      if (!Number.isFinite(bytes)) return NONE;
      return Math.round((bytes / 1048576) * 10) / 10;
    },
  };

  return {
    names: [
      "weather",
      "mac_vendor",
      "ssl_expiry",
      "cert",
      "dns",
      "headers",
      "shorten",
      "expand",
      "filesize",
    ],
    builtins,
    isActive: () => false,
    start: () => {},
  };
}
