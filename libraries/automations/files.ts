// libraries/automations/files.ts — work with files and folders from Sprout.
//
//   use "automations"
//   write_file("notes.txt", "hello")   ~ make/overwrite a file next to your program
//   show read_file("notes.txt")        ~ read it back (gives 'nothing' if missing)
//   log("started up")                  ~ append a timestamped line to log.txt
//   show files("Downloads")            ~ list everything in your Downloads folder
//   show newest("Downloads")           ~ the most recently changed file
//   show foldersize("Documents")       ~ a friendly size like "1.4 GB"
//   backup("project", "E:\\Backups")   ~ copy a folder to a USB stick, dated
//   zip("project")                     ~ squash a folder into project.zip
//   snapshot("notes.txt")              ~ keep a quiet history copy you can restore
//   sort_downloads()                   ~ keep tidying Downloads into folders (background)
//
// Most of these are "do it now" actions using plain Node file functions, so they
// return straight away. The one exception is sort_downloads, which keeps watching
// the Downloads folder in the background (isActive() stays true while it's armed).
//
// A bare special name — Downloads, Desktop or Documents — is resolved inside your
// user profile (C:\Users\you\Downloads). Any other name is resolved next to your
// Sprout program, so "notes.txt" lands beside your code.

import { NONE, stringify } from "../../src/interp/values.ts";
import { SList } from "../../src/interp/values.ts";
import type { Value } from "../../src/interp/values.ts";
import type { Interpreter } from "../../src/interp/interpreter.ts";
import { LangError } from "../../src/lang/errors.ts";
import { spawnSync } from "node:child_process";
import {
  readFileSync, writeFileSync, appendFileSync, readdirSync, statSync,
  existsSync, mkdirSync, copyFileSync, renameSync, cpSync,
} from "node:fs";
import { resolve, join, basename, extname } from "node:path";

type Site = { line: number; col: number } | undefined;

export function register(interp: Interpreter) {
  // --- shared little helpers -------------------------------------------------

  // The three "special" places everyone knows, sitting inside the user profile.
  const SPECIALS = new Set(["downloads", "desktop", "documents"]);

  // Resolve a folder/file name to a real path.
  //   "Downloads" / "Desktop" / "Documents"  -> inside your user profile
  //   anything else                          -> next to your Sprout program
  function resolvePath(name: string): string {
    const trimmed = name.trim();
    const home = process.env.USERPROFILE || process.env.HOME || interp.programDir;
    if (SPECIALS.has(trimmed.toLowerCase())) {
      // Title-case the bare name so the folder matches Windows (Downloads, Desktop...).
      const proper = trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
      return home + "\\" + proper;
    }
    return resolve(interp.programDir, trimmed);
  }

  // Read the first argument as a non-empty name, with a friendly error if missing.
  function needName(v: Value | undefined, name: string, example: string, site: Site): string {
    const s = stringify(v ?? NONE).trim();
    if (!s) throw new LangError("Runtime", name + " needs a file or folder name.", site?.line ?? 1, site?.col ?? 1, "Try: " + example);
    return s;
  }

  // Today's date as YYYY-MM-DD, from a fresh clock read.
  function today(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  // The current time as HH:MM:SS (used by log()).
  function clockTime(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  // A timestamp safe for filenames: YYYYMMDD-HHMMSS.
  function stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // Turn a byte count into friendly text: "512 bytes", "3.4 KB", "1.2 GB".
  function friendlySize(bytes: number): string {
    if (bytes < 1024) return bytes + (bytes === 1 ? " byte" : " bytes");
    const units = ["KB", "MB", "GB", "TB"];
    let n = bytes / 1024;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(1) + " " + units[i];
  }

  // Make sure a folder exists (and is a folder) before we list/scan it.
  function needFolder(path: string, original: string, site: Site): void {
    if (!existsSync(path)) throw new LangError("Runtime", "I couldn't find the folder '" + original + "'.", site?.line ?? 1, site?.col ?? 1, "Check the name, or use Downloads / Desktop / Documents.");
    if (!statSync(path).isDirectory()) throw new LangError("Runtime", "'" + original + "' is a file, not a folder.", site?.line ?? 1, site?.col ?? 1, "Pass a folder name here.");
  }

  // Walk a folder tree, calling visit(fullPath, stat) for every FILE inside.
  // Stays robust: anything we can't stat (locked/odd entries) is just skipped.
  function walkFiles(dir: string, visit: (full: string, st: ReturnType<typeof statSync>) => void): void {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const full = join(dir, n);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walkFiles(full, visit);
      else if (st.isFile()) visit(full, st);
    }
  }

  // Pick a file in a folder by comparing them one-by-one with `better`.
  // Returns the winning full path, or NONE if the folder has no matching files.
  // `ext` (like ".png" or "png") narrows it to one file type when given.
  function pickFile(
    folder: string, original: string, ext: string, site: Site,
    better: (cand: ReturnType<typeof statSync>, best: ReturnType<typeof statSync>) => boolean,
  ): Value {
    const path = resolvePath(folder);
    needFolder(path, original, site);
    const want = ext ? "." + ext.replace(/^\./, "").toLowerCase() : "";
    let bestPath = "";
    let bestStat: ReturnType<typeof statSync> | null = null;
    for (const n of readdirSync(path)) {
      const full = join(path, n);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      if (want && extname(n).toLowerCase() !== want) continue;
      if (bestStat === null || better(st, bestStat)) { bestStat = st; bestPath = full; }
    }
    return bestStat === null ? NONE : bestPath;
  }

  // Everything Windows-only (zip / unzip) gets one friendly gate.
  function needWindows(name: string, site: Site): void {
    if (process.platform !== "win32") throw new LangError("Runtime", name + " works on Windows.", site?.line ?? 1, site?.col ?? 1, "This uses a Windows feature.");
  }

  // Where snapshot()/restore()/versions() keep their history copies.
  const HISTORY = join(interp.programDir, ".sprout-history");

  // --- background: sort_downloads -------------------------------------------
  // Each call to sort_downloads arms a watcher (a "job"). While jobs is non-empty
  // the program stays alive after it ends so the watcher can keep tidying.
  type SortJob = { task: string };
  const jobs: SortJob[] = [];
  const timers: Array<ReturnType<typeof setInterval>> = [];

  // Which folder each file extension is filed into.
  const BUCKETS: Record<string, string> = {
    // Images
    jpg: "Images", jpeg: "Images", png: "Images", gif: "Images", bmp: "Images",
    webp: "Images", svg: "Images", heic: "Images", tiff: "Images", ico: "Images",
    // Docs
    pdf: "Docs", doc: "Docs", docx: "Docs", txt: "Docs", rtf: "Docs", odt: "Docs",
    xls: "Docs", xlsx: "Docs", csv: "Docs", ppt: "Docs", pptx: "Docs", md: "Docs",
    // Videos
    mp4: "Videos", mov: "Videos", avi: "Videos", mkv: "Videos", webm: "Videos", wmv: "Videos",
    // Music
    mp3: "Music", wav: "Music", flac: "Music", m4a: "Music", aac: "Music", ogg: "Music",
    // Archives
    zip: "Archives", rar: "Archives", "7z": "Archives", tar: "Archives", gz: "Archives",
  };
  function bucketFor(fileName: string): string {
    const e = extname(fileName).replace(/^\./, "").toLowerCase();
    return BUCKETS[e] || "Other";
  }

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // --- read & write -------------------------------------------------------

    // Read a text file. Gives 'nothing' if the file isn't there.
    //   read_file("notes.txt")
    read_file: (args, site) => {
      const name = needName(args[0], "read_file", 'read_file("notes.txt")', site);
      const path = resolvePath(name);
      if (!existsSync(path)) return NONE;
      try {
        return readFileSync(path, "utf8");
      } catch (e) {
        throw new LangError("Runtime", "I couldn't read '" + name + "': " + (e instanceof Error ? e.message : String(e)), site?.line ?? 1, site?.col ?? 1, "Make sure it's a text file you can open.");
      }
    },

    // Make (or overwrite) a file with this text. Gives back the name.
    //   write_file("notes.txt", "hello")
    write_file: (args, site) => {
      const name = needName(args[0], "write_file", 'write_file("notes.txt", "hello")', site);
      const path = resolvePath(name);
      try {
        writeFileSync(path, stringify(args[1] ?? NONE), "utf8");
      } catch (e) {
        throw new LangError("Runtime", "I couldn't write '" + name + "': " + (e instanceof Error ? e.message : String(e)), site?.line ?? 1, site?.col ?? 1, "Check the folder exists and isn't read-only.");
      }
      return name;
    },

    // Add text to the END of a file (making it if needed). Gives back the name.
    //   append_file("notes.txt", "another line\n")
    append_file: (args, site) => {
      const name = needName(args[0], "append_file", 'append_file("notes.txt", "more")', site);
      const path = resolvePath(name);
      try {
        appendFileSync(path, stringify(args[1] ?? NONE), "utf8");
      } catch (e) {
        throw new LangError("Runtime", "I couldn't add to '" + name + "': " + (e instanceof Error ? e.message : String(e)), site?.line ?? 1, site?.col ?? 1, "Check the folder exists and isn't read-only.");
      }
      return name;
    },

    // Append a timestamped line to a log file (default "log.txt"). Gives nothing.
    //   log("server started")            -> "14:05:09  server started" in log.txt
    //   log("done", "runs.txt")          -> into runs.txt instead
    log: (args, site) => {
      const msg = stringify(args[0] ?? NONE);
      const file = args[1] != null ? stringify(args[1]).trim() : "log.txt";
      const path = resolvePath(file || "log.txt");
      try {
        appendFileSync(path, clockTime() + "  " + msg + "\n", "utf8");
      } catch (e) {
        throw new LangError("Runtime", "I couldn't write to the log: " + (e instanceof Error ? e.message : String(e)), site?.line ?? 1, site?.col ?? 1, "Check the folder exists and isn't read-only.");
      }
      return NONE;
    },

    // --- listing & picking files -------------------------------------------

    // List the names of everything in a folder (files and subfolders).
    //   files("Downloads")
    files: (args, site) => {
      const name = needName(args[0], "files", 'files("Downloads")', site);
      const path = resolvePath(name);
      needFolder(path, name, site);
      const names = readdirSync(path);
      return new SList(names.map((n) => n as Value));
    },

    // The most RECENTLY changed file in a folder, as a full path (or nothing).
    //   newest("Downloads")          -> the latest of any kind
    //   newest("Downloads", "png")   -> the latest .png only
    newest: (args, site) => {
      const name = needName(args[0], "newest", 'newest("Downloads")', site);
      const ext = args[1] != null ? stringify(args[1]).trim() : "";
      return pickFile(name, name, ext, site, (c, b) => c.mtimeMs > b.mtimeMs);
    },

    // The OLDEST (least recently changed) file in a folder, as a full path.
    //   oldest("Downloads")
    oldest: (args, site) => {
      const name = needName(args[0], "oldest", 'oldest("Downloads")', site);
      const ext = args[1] != null ? stringify(args[1]).trim() : "";
      return pickFile(name, name, ext, site, (c, b) => c.mtimeMs < b.mtimeMs);
    },

    // The BIGGEST file in a folder (by size), as a full path.
    //   biggest("Downloads")
    biggest: (args, site) => {
      const name = needName(args[0], "biggest", 'biggest("Downloads")', site);
      const ext = args[1] != null ? stringify(args[1]).trim() : "";
      return pickFile(name, name, ext, site, (c, b) => c.size > b.size);
    },

    // The total size of a folder (everything inside it), as friendly text.
    //   foldersize("Documents")   -> "1.4 GB"
    foldersize: (args, site) => {
      const name = needName(args[0], "foldersize", 'foldersize("Documents")', site);
      const path = resolvePath(name);
      needFolder(path, name, site);
      let total = 0;
      walkFiles(path, (_full, st) => { total += st.size; });
      return friendlySize(total);
    },

    // How many files a folder holds (counting everything inside subfolders too).
    //   count("Downloads")
    count: (args, site) => {
      const name = needName(args[0], "count", 'count("Downloads")', site);
      const path = resolvePath(name);
      needFolder(path, name, site);
      let n = 0;
      walkFiles(path, () => { n++; });
      return n;
    },

    // How much room is left on a drive, as friendly text.
    //   freespace()      -> the C: drive
    //   freespace("E")   -> a specific drive letter
    freespace: (args, site) => {
      needWindows("freespace", site);
      let letter = (args[0] != null ? stringify(args[0]).trim() : "C").replace(/[:\\]/g, "");
      if (!letter) letter = "C";
      letter = letter.charAt(0).toUpperCase();
      const r = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-PSDrive " + letter + ").Free"], { encoding: "utf8", timeout: 8000 });
      const free = Number((r.stdout || "").trim());
      if (r.status !== 0 || !Number.isFinite(free)) {
        throw new LangError("Runtime", "I couldn't read the free space on drive " + letter + ":.", site?.line ?? 1, site?.col ?? 1, "Check the drive letter exists.");
      }
      return friendlySize(free) + " free";
    },

    // --- opening & copying --------------------------------------------------

    // Open a folder (or file's folder) in File Explorer. Gives nothing.
    //   open_folder("Downloads")
    open_folder: (args, site) => {
      const name = needName(args[0], "open_folder", 'open_folder("Downloads")', site);
      const path = resolvePath(name);
      if (!existsSync(path)) throw new LangError("Runtime", "I couldn't find '" + name + "' to open.", site?.line ?? 1, site?.col ?? 1, "Check the name, or use Downloads / Desktop / Documents.");
      spawnSync("explorer", [path], { encoding: "utf8", timeout: 8000 });
      return NONE;
    },

    // Copy a folder to another place, stamped with today's date.
    //   backup("project", "E:\\Backups")  -> E:\Backups\project-2026-06-08
    // Gives back the full path of the backup it made.
    backup: (args, site) => {
      const srcName = needName(args[0], "backup", 'backup("project", "E:\\\\Backups")', site);
      const destName = needName(args[1], "backup", 'backup("project", "E:\\\\Backups")', site);
      const src = resolvePath(srcName);
      const dest = resolve(interp.programDir, destName);
      if (!existsSync(src)) throw new LangError("Runtime", "I couldn't find '" + srcName + "' to back up.", site?.line ?? 1, site?.col ?? 1, "Check the folder name.");
      if (!existsSync(dest)) throw new LangError("Runtime", "I couldn't find the backup spot '" + destName + "'.", site?.line ?? 1, site?.col ?? 1, "Is the USB plugged in?");
      const out = join(dest, basename(src) + "-" + today());
      try {
        cpSync(src, out, { recursive: true });
      } catch (e) {
        throw new LangError("Runtime", "The backup didn't finish: " + (e instanceof Error ? e.message : String(e)), site?.line ?? 1, site?.col ?? 1, "Is there room on the drive, and is the USB plugged in?");
      }
      return out;
    },

    // Squash a folder or file into a .zip. Gives back the zip's path.
    //   zip("project")                    -> project.zip next to it
    //   zip("project", "out.zip")         -> a chosen name
    zip: (args, site) => {
      needWindows("zip", site);
      const srcName = needName(args[0], "zip", 'zip("project")', site);
      const src = resolvePath(srcName);
      if (!existsSync(src)) throw new LangError("Runtime", "I couldn't find '" + srcName + "' to zip.", site?.line ?? 1, site?.col ?? 1, "Check the name.");
      const out = args[1] != null && stringify(args[1]).trim()
        ? resolvePath(stringify(args[1]).trim())
        : src.replace(/[\\/]+$/, "") + ".zip";
      const esc = (s: string) => s.replace(/'/g, "''");
      const r = spawnSync("powershell", ["-NoProfile", "-Command",
        "Compress-Archive -Path '" + esc(src) + "' -DestinationPath '" + esc(out) + "' -Force"], { encoding: "utf8", timeout: 120000 });
      if (r.status !== 0) throw new LangError("Runtime", "I couldn't make the zip: " + ((r.stderr || "").trim() || "failed"), site?.line ?? 1, site?.col ?? 1, "Check the source exists and the name is free.");
      return out;
    },

    // Unpack a .zip into a folder (made if needed). Gives back the folder path.
    //   unzip("photos.zip")               -> a "photos" folder beside it
    //   unzip("photos.zip", "out")        -> into a chosen folder
    unzip: (args, site) => {
      needWindows("unzip", site);
      const zipName = needName(args[0], "unzip", 'unzip("photos.zip")', site);
      const zipPath = resolvePath(zipName);
      if (!existsSync(zipPath)) throw new LangError("Runtime", "I couldn't find '" + zipName + "' to unzip.", site?.line ?? 1, site?.col ?? 1, "Check the name.");
      const out = args[1] != null && stringify(args[1]).trim()
        ? resolvePath(stringify(args[1]).trim())
        : zipPath.replace(/\.zip$/i, "");
      const esc = (s: string) => s.replace(/'/g, "''");
      const r = spawnSync("powershell", ["-NoProfile", "-Command",
        "Expand-Archive -Path '" + esc(zipPath) + "' -DestinationPath '" + esc(out) + "' -Force"], { encoding: "utf8", timeout: 120000 });
      if (r.status !== 0) throw new LangError("Runtime", "I couldn't unzip that: " + ((r.stderr || "").trim() || "failed"), site?.line ?? 1, site?.col ?? 1, "Make sure it's a real .zip file.");
      return out;
    },

    // --- quiet version history ---------------------------------------------

    // Keep a quiet history copy of a file, stamped with the date and time.
    // Copies land in a hidden ".sprout-history" folder next to your program.
    //   snapshot("notes.txt")
    snapshot: (args, site) => {
      const name = needName(args[0], "snapshot", 'snapshot("notes.txt")', site);
      const path = resolvePath(name);
      if (!existsSync(path)) throw new LangError("Runtime", "I couldn't find '" + name + "' to snapshot.", site?.line ?? 1, site?.col ?? 1, "Check the file name.");
      try {
        mkdirSync(HISTORY, { recursive: true });
        copyFileSync(path, join(HISTORY, basename(path) + "." + stamp() + ".bak"));
      } catch (e) {
        throw new LangError("Runtime", "I couldn't save a snapshot: " + (e instanceof Error ? e.message : String(e)), site?.line ?? 1, site?.col ?? 1, "Check there's room on the disk.");
      }
      return NONE;
    },

    // Restore a file from its NEWEST snapshot (overwrites the current file).
    //   restore("notes.txt")
    restore: (args, site) => {
      const name = needName(args[0], "restore", 'restore("notes.txt")', site);
      const path = resolvePath(name);
      const base = basename(path);
      if (!existsSync(HISTORY)) throw new LangError("Runtime", "There are no snapshots of '" + name + "' yet.", site?.line ?? 1, site?.col ?? 1, "Use snapshot(...) first to save one.");
      // The snapshot name is "<base>.<YYYYMMDD-HHMMSS>.bak"; sorting the matching
      // ones puts the newest stamp last.
      const prefix = base + ".";
      const copies = readdirSync(HISTORY).filter((n) => n.startsWith(prefix) && n.endsWith(".bak")).sort();
      if (copies.length === 0) throw new LangError("Runtime", "There are no snapshots of '" + name + "' yet.", site?.line ?? 1, site?.col ?? 1, "Use snapshot(...) first to save one.");
      try {
        copyFileSync(join(HISTORY, copies[copies.length - 1]), path);
      } catch (e) {
        throw new LangError("Runtime", "I couldn't restore '" + name + "': " + (e instanceof Error ? e.message : String(e)), site?.line ?? 1, site?.col ?? 1, "Check the file isn't open elsewhere.");
      }
      return NONE;
    },

    // List the saved snapshot copies of a file (oldest first).
    //   versions("notes.txt")
    versions: (args, site) => {
      const name = needName(args[0], "versions", 'versions("notes.txt")', site);
      const path = resolvePath(name);
      const base = basename(path);
      if (!existsSync(HISTORY)) return new SList([]);
      const prefix = base + ".";
      const copies = readdirSync(HISTORY).filter((n) => n.startsWith(prefix) && n.endsWith(".bak")).sort();
      return new SList(copies.map((n) => n as Value));
    },

    // --- background tidy ----------------------------------------------------

    // Keep tidying your Downloads folder into category folders, in the background.
    // New files are sorted into Images / Docs / Videos / Music / Archives / Other
    // once they finish downloading.
    //   sort_downloads()              -> just sort
    //   sort_downloads("note_me")     -> also run a task for each sorted file
    sort_downloads: (args, site) => {
      needWindows("sort_downloads", site);
      const task = args[0] != null ? stringify(args[0]).trim() : "";
      jobs.push({ task });
      return NONE;
    },
  };

  // ===========================================================================
  // start() — turn the registered sort_downloads job(s) into a live loop. We poll
  // the Downloads folder; a file is only sorted once its size has held steady for
  // a tick (so we don't grab a half-finished download). State lives in closures.
  // ===========================================================================
  const start = (): void => {
    if (jobs.length === 0) return;

    const home = process.env.USERPROFILE || process.env.HOME || interp.programDir;
    const downloads = home + "\\Downloads";
    const buckets = new Set(Object.values(BUCKETS).concat("Other"));

    // Remember the size we last saw for each file, so we can tell when it's stable.
    const lastSize = new Map<string, number>();
    // The tasks to run per sorted file (drop blanks).
    const tasks = jobs.map((j) => j.task).filter((t) => t.length > 0);

    timers.push(setInterval(() => {
      let names: string[];
      try { names = readdirSync(downloads); } catch { return; }
      for (const n of names) {
        // Skip our own destination folders and anything still in-flight.
        if (buckets.has(n)) continue;
        if (/\.(crdownload|part|tmp)$/i.test(n) || n.startsWith(".")) continue;
        const full = join(downloads, n);
        let st: ReturnType<typeof statSync>;
        try { st = statSync(full); } catch { continue; }
        if (!st.isFile()) continue;

        const prev = lastSize.get(full);
        // Wait until we've seen this exact size twice in a row (download settled).
        if (prev === undefined || prev !== st.size) { lastSize.set(full, st.size); continue; }

        const bucket = bucketFor(n);
        const destDir = join(downloads, bucket);
        try {
          mkdirSync(destDir, { recursive: true });
          // Avoid clobbering: if the name's taken, tack on a counter.
          let target = join(destDir, n);
          if (existsSync(target)) {
            const stem = basename(n, extname(n));
            const ext = extname(n);
            let i = 2;
            while (existsSync(join(destDir, stem + " (" + i + ")" + ext))) i++;
            target = join(destDir, stem + " (" + i + ")" + ext);
          }
          renameSync(full, target);
          lastSize.delete(full);
          // Optionally let the program react to each sorted file.
          for (const t of tasks) {
            try { interp.runTask(t); }
            catch (e) { console.error("📁 sort_downloads task '" + t + "' had a problem: " + (e instanceof Error ? e.message : String(e))); }
          }
        } catch {
          // The file might be locked (still opening). Leave it; we'll retry later.
        }
      }
    }, 1500));

    console.log("📁 sort_downloads is tidying your Downloads folder.");
    console.log("   (press Ctrl+C to stop)");
  };

  return {
    names: [
      "read_file", "write_file", "append_file", "log",
      "files", "newest", "oldest", "biggest",
      "foldersize", "count", "freespace",
      "open_folder", "backup", "zip", "unzip",
      "snapshot", "restore", "versions",
      "sort_downloads",
    ],
    builtins,
    // Background work is on only while sort_downloads is armed.
    isActive: () => jobs.length > 0,
    start,
  };
}
