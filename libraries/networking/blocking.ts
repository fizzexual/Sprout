// libraries/networking/blocking.ts — website blocking for Sprout.
//
//   block("youtube.com")          # won't load in any browser (needs admin)
//   show isblocked("youtube.com") # -> yes
//   show blocked()                # -> ["youtube.com"]
//   unblock("youtube.com")
//   block_category("social")      # block a whole bundle at once
//   block_until("reddit.com", "30 minutes")   # blocks now, frees itself later
//
// How it works: blocking a site means adding a line to the system "hosts" file
// that points the site's name at 127.0.0.1 (this computer), so the request never
// reaches the real server. We TAG every line Sprout adds, so unblock / blocked
// only ever touch what Sprout wrote — never the user's own hosts entries.
//
// The interpreter is synchronous, so everything here is plain synchronous file
// work. Editing the hosts file needs administrator (Windows) / sudo (others).

import { NONE, stringify, SList } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

type Site = { line: number; col: number } | undefined;

// Where the hosts file lives, and how we mark our own lines.
const HOSTS = process.platform === "win32"
  ? (process.env.SystemRoot || "C:\\Windows") + "\\System32\\drivers\\etc\\hosts"
  : "/etc/hosts";
const TAG = "# sprout-block";
const NL = process.platform === "win32" ? "\r\n" : "\n";

// Read the hosts file's text — or "" if we can't (missing / no permission to read).
function readHosts(): string {
  try { return readFileSync(HOSTS, "utf8"); } catch { return ""; }
}

// "https://www.Example.com/page" -> "example.com"  (scheme, path, www, case stripped)
function cleanDomain(s: string): string {
  return s.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./i, "").trim().toLowerCase();
}

// After changing the hosts file, ask Windows to forget any cached lookups so the
// block (or unblock) takes effect right away. Best-effort — never fails loudly.
function flushDns(): void {
  try { if (process.platform === "win32") spawnSync("ipconfig", ["/flushdns"], { stdio: "ignore", timeout: 5000 }); } catch { /* best effort */ }
}

// Pull a Node/system error's short code (e.g. "EBUSY", "EPERM") if it has one.
function errCode(e: unknown): string {
  return (e && typeof e === "object" && "code" in e) ? String((e as { code: unknown }).code) : "";
}

// A synchronous pause (the interpreter is synchronous, so we just block briefly).
function sleepMs(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

// The friendly "you need to be admin" error, tailored per platform.
function adminError(site: Site): LangError {
  return new LangError("Runtime", "Blocking a website needs administrator rights.", site?.line ?? 1, site?.col ?? 1,
    process.platform === "win32"
      ? "Close this, right-click your terminal (or VS Code), choose 'Run as administrator', and run your program again."
      : "Run your program with sudo to edit the hosts file.");
}

// A friendly error for anything else that goes wrong touching the hosts file.
function netError(msg: string, site: Site): LangError {
  return new LangError("Runtime", "Blocking problem: " + msg, site?.line ?? 1, site?.col ?? 1, "Check the address and try again.");
}

// Save new hosts text — robustly.
// The hosts file is often briefly LOCKED right after a change (antivirus scans it,
// the DNS service reloads it), so a plain overwrite can fail with EBUSY. We retry,
// and under a lock we delete + recreate the file so we get a fresh, unlocked handle.
// A real permission problem (not elevated) shows up on the very FIRST try.
function writeHosts(text: string, site: Site): void {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      if (attempt > 0) { try { unlinkSync(HOSTS); } catch { /* may be missing or momentarily locked */ } }
      writeFileSync(HOSTS, text);
      flushDns();
      return;
    } catch (e) {
      lastErr = e;
      const code = errCode(e);
      if ((code === "EPERM" || code === "EACCES") && attempt === 0) throw adminError(site);
      sleepMs(Math.min(120 + attempt * 40, 500));   // EBUSY / locked: wait, then retry
    }
  }
  throw netError("the hosts file stayed locked by another program (" + (lastErr instanceof Error ? lastErr.message : String(lastErr)) + "). Pause real-time antivirus or close any hosts editor, then try again.", site);
}

// Does a hosts line block this exact domain (apex or www)? (only our tagged lines)
function lineBlocks(line: string, domain: string): boolean {
  return line.includes(TAG) && (line.includes(" " + domain + " ") || line.includes(" www." + domain + " "));
}

// Bundled domain lists, so you can block a whole theme at once.
const CATEGORIES: Record<string, string[]> = {
  // Common ad networks & trackers.
  ads: [
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "google-analytics.com",
    "adservice.google.com",
    "ads.yahoo.com",
    "adnxs.com",
    "advertising.com",
    "scorecardresearch.com",
    "taboola.com",
    "outbrain.com",
  ],
  // Social media.
  social: ["facebook.com", "instagram.com", "tiktok.com", "twitter.com", "x.com", "reddit.com", "snapchat.com"],
  // Big gaming / store platforms.
  gaming: ["steampowered.com", "epicgames.com", "roblox.com", "ea.com", "twitch.tv", "miniclip.com", "poki.com"],
  // News & their endless feeds.
  news: ["cnn.com", "bbc.com", "nytimes.com", "foxnews.com", "buzzfeed.com", "reuters.com", "theguardian.com"],
};

// Turn a duration into seconds. Accepts a number (seconds) OR friendly text like
// "10 minutes", "2h", "1 day".
function parseDuration(v: Value | undefined, site: Site): number {
  if (typeof v === "number") return v;
  const s = stringify(v ?? NONE).trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/);
  if (!m) throw new LangError("Runtime", "I couldn't understand the time '" + s + "'.", site?.line ?? 1, site?.col ?? 1, 'Use seconds, or text like "10 minutes".');
  const n = Number(m[1]);
  const u = (m[2] || "s")[0];
  const mult = u === "d" ? 86400 : u === "h" ? 3600 : u === "m" ? 60 : 1;
  return n * mult;
}

export function register(interp: Interpreter) {
  // Pending timed unblocks: {domain, atMs}. block_until() fills this; start() arms
  // the timers and isActive() keeps Sprout alive while any are waiting.
  const jobs: { domain: string; atMs: number }[] = [];

  // Core block/unblock writers, shared by the builtins (and by the timers in start).

  // Remove any existing lines for this domain, then add the apex + www block lines.
  // `extraTag` lets category / timed blocks carry their own marker (still contains TAG).
  function doBlock(domain: string, site: Site, extraTag: string): void {
    const tag = extraTag ? TAG + " " + extraTag : TAG;
    const kept = readHosts().split(/\r?\n/).filter((l) => !lineBlocks(l, domain));
    while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
    kept.push("127.0.0.1 " + domain + " " + tag);
    kept.push("127.0.0.1 www." + domain + " " + tag);
    writeHosts(kept.join(NL) + NL, site);
  }

  // Remove every tagged line for this domain.
  function doUnblock(domain: string, site: Site): void {
    const kept = readHosts().split(/\r?\n/).filter((l) => !lineBlocks(l, domain));
    writeHosts(kept.join(NL), site);
  }

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // Block a website on THIS computer — it won't load in any browser. Needs admin.
    block: (args, site) => {
      const domain = cleanDomain(stringify(args[0] ?? NONE));
      if (!domain) throw new LangError("Runtime", "block needs a website address.", site?.line ?? 1, site?.col ?? 1, 'Try: block("example.com")');
      doBlock(domain, site, "");
      return NONE;
    },

    // Unblock a website you blocked earlier. Needs admin.
    unblock: (args, site) => {
      const domain = cleanDomain(stringify(args[0] ?? NONE));
      if (!domain) throw new LangError("Runtime", "unblock needs a website address.", site?.line ?? 1, site?.col ?? 1, 'Try: unblock("example.com")');
      doUnblock(domain, site);
      return NONE;
    },

    // Is a website blocked on this computer right now? -> yes / no
    isblocked: (args) => {
      const domain = cleanDomain(stringify(args[0] ?? NONE));
      return domain ? readHosts().split(/\r?\n/).some((l) => lineBlocks(l, domain)) : false;
    },

    // A list of the websites you've blocked (apex domains, www stripped).
    blocked: () => {
      const found = new Set<string>();
      for (const l of readHosts().split(/\r?\n/)) {
        if (!l.includes(TAG)) continue;
        const m = l.match(/^\s*\S+\s+(\S+)/);
        if (m) found.add(m[1].replace(/^www\./i, ""));
      }
      return new SList([...found]);
    },

    // Remove every site Sprout blocked, all at once. Needs admin.
    unblock_all: (args, site) => {
      const kept = readHosts().split(/\r?\n/).filter((l) => !l.includes(TAG));
      writeHosts(kept.join(NL), site);
      return NONE;
    },

    // Block a whole bundle of sites by theme: "ads", "social", "gaming", "news". Needs admin.
    block_category: (args, site) => {
      const cat = stringify(args[0] ?? NONE).trim().toLowerCase();
      const list = CATEGORIES[cat];
      if (!list) throw new LangError("Runtime", "I don't know the category '" + cat + "'.", site?.line ?? 1, site?.col ?? 1, "Try one of: " + Object.keys(CATEGORIES).join(", ") + ".");
      for (const raw of list) doBlock(cleanDomain(raw), site, "cat:" + cat);
      return NONE;
    },

    // Unblock a whole category you blocked with block_category. Needs admin.
    unblock_category: (args, site) => {
      const cat = stringify(args[0] ?? NONE).trim().toLowerCase();
      if (!CATEGORIES[cat]) throw new LangError("Runtime", "I don't know the category '" + cat + "'.", site?.line ?? 1, site?.col ?? 1, "Try one of: " + Object.keys(CATEGORIES).join(", ") + ".");
      const kept = readHosts().split(/\r?\n/).filter((l) => !l.includes("cat:" + cat));
      writeHosts(kept.join(NL), site);
      return NONE;
    },

    // Block a site NOW, then automatically free it later. Time can be a number of
    // seconds, or text like "30 minutes" / "2h" / "1 day". Needs admin.
    block_until: (args, site) => {
      const domain = cleanDomain(stringify(args[0] ?? NONE));
      if (!domain) throw new LangError("Runtime", "block_until needs a website address.", site?.line ?? 1, site?.col ?? 1, 'Try: block_until("example.com", "30 minutes")');
      const secs = parseDuration(args[1], site);
      const atMs = Date.now() + secs * 1000;
      doBlock(domain, site, "until:" + atMs);
      jobs.push({ domain, atMs });
      return NONE;
    },
  };

  return {
    names: ["block", "unblock", "isblocked", "blocked", "unblock_all", "block_category", "unblock_category", "block_until"],
    builtins,
    // Keep Sprout alive only while a timed block is still waiting to expire.
    isActive: () => jobs.length > 0,
    // Arm the timers for every block_until, and sweep away any already-expired
    // "until:" lines left over from a previous run.
    start: () => {
      // 1) Clean up timed blocks whose moment has already passed.
      const now = Date.now();
      let changed = false;
      const kept = readHosts().split(/\r?\n/).filter((l) => {
        const m = l.match(/until:(\d+)/);
        if (m && Number(m[1]) <= now) { changed = true; return false; }
        return true;
      });
      if (changed) {
        try { writeHosts(kept.join(NL), undefined); } catch (e) { console.error("Couldn't tidy expired blocks: " + (e instanceof Error ? e.message : String(e))); }
      }

      // 2) Arm a timer for each pending timed block to unblock itself.
      for (const job of jobs) {
        const delay = Math.max(0, job.atMs - Date.now());
        setTimeout(() => {
          try { doUnblock(job.domain, undefined); } catch (e) { console.error("Couldn't auto-unblock " + job.domain + ": " + (e instanceof Error ? e.message : String(e))); }
        }, delay);
      }
    },
  };
}
