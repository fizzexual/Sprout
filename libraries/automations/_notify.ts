// libraries/automations/_notify.ts — a shared Windows toast helper whose app
// NAME and ICON you can change from a "notify.bloom" file next to your program.
//
//   ~ notify.bloom
//   name: My Cool App
//   icon: myicon.png        ~ a .png next to this file
//
// Windows shows the toast under an "AppUserModelID" — by default that's
// PowerShell's, which is why the header says "Windows PowerShell". We register a
// per-user app identity (no admin) with a DisplayName + IconUri, so toasts show
// YOUR name + icon instead. Used by notify() (stats) and remind()/timer() (reminders).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AUMID = "Sprout.Notifications";

// A friendly default icon: the Sprout leaf that ships with the language.
let DEFAULT_ICON = "";
try { DEFAULT_ICON = fileURLToPath(new URL("../../images/sprout.png", import.meta.url)); } catch { /* ignore */ }

// Read name + icon from notify.bloom next to the program (creating a template the
// first time, so the user has something to edit).
function loadConfig(programDir: string): { name: string; icon: string } {
  const dir = programDir || ".";
  const path = resolve(dir, "notify.bloom");
  let name = "Sprout";
  let icon = "";
  if (existsSync(path)) {
    try {
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        if (line.trim().startsWith("~")) continue;
        const m = line.match(/^\s*(name|icon)\s*:\s*(.*?)\s*$/i);
        if (!m) continue;
        if (m[1].toLowerCase() === "name" && m[2]) name = m[2];
        if (m[1].toLowerCase() === "icon" && m[2]) icon = m[2];
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

// Register (or update) our per-user app identity so Windows knows the name + icon.
function register(name: string, icon: string): void {
  const key = "HKCU\\Software\\Classes\\AppUserModelId\\" + AUMID;
  spawnSync("reg", ["add", key, "/v", "DisplayName", "/t", "REG_SZ", "/d", name, "/f"], { stdio: "ignore", timeout: 5000 });
  if (icon) spawnSync("reg", ["add", key, "/v", "IconUri", "/t", "REG_SZ", "/d", icon, "/f"], { stdio: "ignore", timeout: 5000 });
  else spawnSync("reg", ["delete", key, "/v", "IconUri", "/f"], { stdio: "ignore", timeout: 5000 });
}

// Show a Windows toast under our (configurable) app identity.
export function showToast(programDir: string, title: string, message: string): void {
  if (process.platform !== "win32") return;
  const cfg = loadConfig(programDir);
  register(cfg.name, cfg.icon);
  const script =
    "[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];" +
    "[void][Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime];" +
    "[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime];" +
    "$xml=\"<toast><visual><binding template='ToastGeneric'><text>$env:T_TITLE</text><text>$env:T_MSG</text></binding></visual></toast>\";" +
    "$d=[Windows.Data.Xml.Dom.XmlDocument]::new(); $d.LoadXml($xml);" +
    "$t=[Windows.UI.Notifications.ToastNotification]::new($d);" +
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + AUMID + "').Show($t);";
  spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 8000, env: { ...process.env, T_TITLE: title, T_MSG: message } });
}
