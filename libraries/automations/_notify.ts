// libraries/automations/_notify.ts — a shared Windows toast helper whose app
// NAME and ICON you can change from a "notify.bloom" file next to your program.
//
//   ~ notify.bloom
//   name: My Cool App
//   icon: myicon.png        ~ a .png next to this file
//
// Windows shows a toast under an "AppUserModelID" (AUMID) — by default that's
// PowerShell's, hence "Windows PowerShell". We register a per-user app identity
// (no admin) with a DisplayName + IconUri so toasts show YOUR name + icon.
//
// IMPORTANT: Windows caches the display name per AUMID, so editing the name of
// the SAME id would keep showing the old name. We dodge that by deriving the
// AUMID FROM the name+icon — change either and it becomes a brand-new id Windows
// shows fresh — and we delete the stale Sprout.* ids each time. Used by notify()
// (stats) and remind()/timer() (reminders).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AUMID_ROOT = "HKCU\\Software\\Classes\\AppUserModelId";

// A friendly default icon: the Sprout leaf that ships with the language.
let DEFAULT_ICON = "";
try { DEFAULT_ICON = fileURLToPath(new URL("../../images/sprout.png", import.meta.url)); } catch { /* ignore */ }

// Read name + icon from notify.bloom next to the program (creating a template the
// first time, so the user has something to edit). Trailing "~ comments" are stripped.
function loadConfig(programDir: string): { name: string; icon: string } {
  const dir = programDir || ".";
  const path = resolve(dir, "notify.bloom");
  let name = "Sprout";
  let icon = "";
  if (existsSync(path)) {
    try {
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        if (line.trim().startsWith("~")) continue;
        const m = line.match(/^\s*(name|icon)\s*:\s*(.*)$/i);
        if (!m) continue;
        const value = m[2].split(/\s+~/)[0].trim();   // drop a trailing ~ comment
        if (!value) continue;
        if (m[1].toLowerCase() === "name") name = value;
        else icon = value;
      }
    } catch { /* ignore */ }
  } else {
    try {
      writeFileSync(path,
        "~ notify.bloom - how your pop-up notifications look.\n" +
        "~ Change these, then your toasts show YOUR name + icon (not \"Windows PowerShell\").\n" +
        "name: Sprout\n" +
        "icon:        ~ a .png next to this file (optional; blank = the Sprout leaf)\n");
    } catch { /* ignore */ }
  }
  const iconPath = icon ? resolve(dir, icon) : DEFAULT_ICON;
  return { name, icon: iconPath && existsSync(iconPath) ? iconPath : "" };
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "").slice(0, 32) || "App";
}

// A tiny stable hash so any name/icon change yields a different AUMID.
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// Remove stale "Sprout.*" identities we registered before, except the current one.
function cleanupOld(current: string): void {
  const r = spawnSync("reg", ["query", AUMID_ROOT], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return;
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!/\\AppUserModelId\\Sprout\./i.test(t)) continue;
    const id = t.slice(t.lastIndexOf("\\") + 1);
    if (id && id !== current) spawnSync("reg", ["delete", AUMID_ROOT + "\\" + id, "/f"], { stdio: "ignore", timeout: 5000 });
  }
}

// Show a Windows toast under our (configurable) app identity.
export function showToast(programDir: string, title: string, message: string): void {
  if (process.platform !== "win32") return;
  const cfg = loadConfig(programDir);
  // AUMID derived from name+icon so a change always shows fresh (beats the cache).
  const aumid = "Sprout." + sanitize(cfg.name) + "." + shortHash(cfg.name + "|" + cfg.icon);
  cleanupOld(aumid);
  const key = AUMID_ROOT + "\\" + aumid;
  spawnSync("reg", ["add", key, "/v", "DisplayName", "/t", "REG_SZ", "/d", cfg.name, "/f"], { stdio: "ignore", timeout: 5000 });
  if (cfg.icon) spawnSync("reg", ["add", key, "/v", "IconUri", "/t", "REG_SZ", "/d", cfg.icon, "/f"], { stdio: "ignore", timeout: 5000 });
  const script =
    "[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];" +
    "[void][Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime];" +
    "[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime];" +
    "$xml=\"<toast><visual><binding template='ToastGeneric'><text>$env:T_TITLE</text><text>$env:T_MSG</text></binding></visual></toast>\";" +
    "$d=[Windows.Data.Xml.Dom.XmlDocument]::new(); $d.LoadXml($xml);" +
    "$t=[Windows.UI.Notifications.ToastNotification]::new($d);" +
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:T_AUMID).Show($t);";
  spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 8000, env: { ...process.env, T_TITLE: title, T_MSG: message, T_AUMID: aumid } });
}
