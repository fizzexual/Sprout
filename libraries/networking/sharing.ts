// libraries/networking/sharing.ts — serve & share things to your phone.
//
//   use "networking"          ~ this module is part of the networking library
//   show share("photo.jpg")   ~ a download link your phone can open
//   show serve("my-folder")   ~ browse a whole folder from your phone
//   show sharetext("Wifi: hunter2")   ~ a page with a Copy button
//   sendphone("my-alerts", "Dinner is ready!")   ~ a push notification
//   qr("https://sprout-lang.dev")            ~ print a QR code in the terminal
//   qr("https://sprout-lang.dev", "code.png") ~ save a QR code as a picture
//
// share / serve / sharetext start tiny zero-dependency web servers that live on
// your home network. Open the printed http://192.168.x.x:8000/ link on a phone
// (same Wi-Fi) and it just works. The servers keep Sprout alive — like a bot's
// listen loop — until you press Ctrl+C.
//
// QR: this file implements a REAL, from-scratch QR encoder (byte mode, low error
// correction, Reed-Solomon over GF(256), one fixed data mask, versions 1–10).
// No network needed. qr(text) prints it; qr(text, file) saves a 1-bit PNG.

import { NONE, stringify } from "../../src/interp/values.ts";
import type { Value } from "../../src/interp/values.ts";
import type { Interpreter } from "../../src/interp/interpreter.ts";
import { LangError } from "../../src/lang/errors.ts";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { createReadStream, statSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join, basename, extname } from "node:path";
import { deflateSync } from "node:zlib";

type Site = { line: number; col: number } | undefined;

export function register(interp: Interpreter) {
  // Every running server we've started, so isActive() / start() can manage them.
  type Job = {
    label: string;                      // a friendly one-line description for the startup banner
    port: number;                       // the port we settled on (after bumping past anything in use)
    server: Server;                     // the not-yet-listening http server
  };
  const servers: Job[] = [];

  // --- helpers ----------------------------------------------------------------

  // This computer's address on your home/office network, e.g. 192.168.1.20.
  // We skip "internal" interfaces (like 127.0.0.1) so a phone can actually reach it.
  function localIp(): string {
    const ifs = networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const net of ifs[name] ?? []) {
        if ((net.family === "IPv4" || (net.family as unknown) === 4) && !net.internal) return net.address;
      }
    }
    return "127.0.0.1";
  }

  // Try to listen on `start`; if it's busy (EADDRINUSE) bump to the next port and
  // try again. Returns the port that worked. Runs the listen synchronously enough
  // for our needs by binding now and letting start() report it.
  // We pick the port up-front so we can return the URL immediately.
  let nextPort = 8000;
  function pickPort(): number {
    // We can't truly bind synchronously, so we hand out increasing ports and rely
    // on the EADDRINUSE handler in start() to bump if one is taken. Starting fresh
    // at 8000 and counting up gives every server its own slot.
    return nextPort++;
  }

  // Guess a Content-Type from a filename so browsers preview images/text inline.
  function contentTypeFor(name: string): string {
    const ext = extname(name).toLowerCase();
    const map: Record<string, string> = {
      ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
      ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
      ".json": "application/json; charset=utf-8", ".csv": "text/csv; charset=utf-8",
      ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
      ".bmp": "image/bmp", ".ico": "image/x-icon",
      ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
      ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
      ".pdf": "application/pdf", ".zip": "application/zip",
    };
    return map[ext] ?? "application/octet-stream";
  }

  // Tiny HTML escape so a filename or shared text can't break out of the page.
  function esc(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;");
  }

  // Run a tiny async Node script and return its stdout (used only by sendphone).
  function runNode(script: string, args: string[], site: Site): string {
    const res = spawnSync(process.execPath, ["-e", script, ...args], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 20000,
    });
    if (res.error) throw new LangError("Runtime", "Network problem: " + res.error.message, site?.line ?? 1, site?.col ?? 1, "Check your connection.");
    if (res.status !== 0) throw new LangError("Runtime", "Network problem: " + ((res.stderr || "").trim() || "failed"), site?.line ?? 1, site?.col ?? 1, "Check the address.");
    return res.stdout ?? "";
  }

  // Register a server, hand back the URL we'll be reachable at.
  function addServer(label: string, server: Server): string {
    const port = pickPort();
    servers.push({ label, port, server });
    return "http://" + localIp() + ":" + port + "/";
  }

  // ===========================================================================
  //  QR CODE ENCODER  (pure TypeScript, no network)
  //  Byte mode, error-correction level L (low), one fixed mask (pattern 0),
  //  versions 1–10. Reed-Solomon error correction over GF(256).
  // ===========================================================================

  // --- GF(256) arithmetic: the finite field QR codes use for Reed-Solomon. ----
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;   // the QR generator polynomial 0x11d
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();

  function gfMul(a: number, b: number): number {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  // Build the Reed-Solomon generator polynomial for `degree` error-correction codewords.
  function rsGenerator(degree: number): number[] {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  // Compute the `degree` error-correction codewords for a block of data bytes.
  function rsEncode(data: number[], degree: number): number[] {
    const gen = rsGenerator(degree);
    const res = new Array(degree).fill(0);
    for (const byte of data) {
      const factor = byte ^ res[0];
      res.shift();
      res.push(0);
      for (let i = 0; i < gen.length - 1; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
    return res;
  }

  // --- Per-version capacity tables (level L, byte mode). ----------------------
  // For each version (1-based index): total data codewords, ec codewords per
  // block, number of blocks in group 1, and (for the bigger versions) group 2.
  // Source: the QR standard's table for ECC level L. We only need versions 1–10.
  type Spec = { totalData: number; ecPerBlock: number; g1Blocks: number; g1Words: number; g2Blocks: number; g2Words: number };
  const SPECS: Spec[] = [
    { totalData: 19, ecPerBlock: 7, g1Blocks: 1, g1Words: 19, g2Blocks: 0, g2Words: 0 },   // v1
    { totalData: 34, ecPerBlock: 10, g1Blocks: 1, g1Words: 34, g2Blocks: 0, g2Words: 0 },   // v2
    { totalData: 55, ecPerBlock: 15, g1Blocks: 1, g1Words: 55, g2Blocks: 0, g2Words: 0 },   // v3
    { totalData: 80, ecPerBlock: 20, g1Blocks: 1, g1Words: 80, g2Blocks: 0, g2Words: 0 },   // v4
    { totalData: 108, ecPerBlock: 26, g1Blocks: 1, g1Words: 108, g2Blocks: 0, g2Words: 0 },  // v5
    { totalData: 136, ecPerBlock: 18, g1Blocks: 2, g1Words: 68, g2Blocks: 0, g2Words: 0 },   // v6
    { totalData: 156, ecPerBlock: 20, g1Blocks: 2, g1Words: 78, g2Blocks: 0, g2Words: 0 },   // v7
    { totalData: 194, ecPerBlock: 24, g1Blocks: 2, g1Words: 97, g2Blocks: 0, g2Words: 0 },   // v8
    { totalData: 232, ecPerBlock: 30, g1Blocks: 2, g1Words: 116, g2Blocks: 0, g2Words: 0 },  // v9
    { totalData: 274, ecPerBlock: 18, g1Blocks: 2, g1Words: 68, g2Blocks: 2, g2Words: 69 },  // v10
  ];

  // Alignment-pattern centre coordinates per version (none for v1).
  const ALIGN_POS: number[][] = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  ];

  // Format-information bits for ECC level L with each mask pattern (pre-computed,
  // 15 bits each, already XOR-masked with 0x5412 as the spec requires).
  const FORMAT_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];

  // The size (modules per side) of a version: 21 for v1, then +4 each version.
  function sizeFor(version: number): number { return 17 + version * 4; }

  // Build the bit-stream of data codewords for `text` at the chosen version.
  function buildDataCodewords(bytes: number[], version: number, spec: Spec): number[] {
    // We assemble individual bits, then pack into bytes (codewords).
    const bits: number[] = [];
    const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };

    push(0b0100, 4);                                   // mode indicator: byte mode
    const lenBits = version <= 9 ? 8 : 16;             // char-count length depends on version
    push(bytes.length, lenBits);
    for (const b of bytes) push(b, 8);                 // the actual data

    const capacityBits = spec.totalData * 8;
    // Terminator: up to four 0 bits, but not past capacity.
    for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
    // Pad to a full byte boundary.
    while (bits.length % 8 !== 0) bits.push(0);

    // Convert bits -> codeword bytes.
    const words: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      words.push(v);
    }
    // Pad with the two alternating pad bytes until we fill the data capacity.
    const PADS = [0xec, 0x11];
    let p = 0;
    while (words.length < spec.totalData) { words.push(PADS[p]); p ^= 1; }
    return words;
  }

  // Split data into blocks, compute EC for each, then interleave per the QR spec.
  function buildFinalCodewords(dataWords: number[], spec: Spec): number[] {
    const blocks: { data: number[]; ec: number[] }[] = [];
    let idx = 0;
    for (let b = 0; b < spec.g1Blocks; b++) {
      const data = dataWords.slice(idx, idx + spec.g1Words); idx += spec.g1Words;
      blocks.push({ data, ec: rsEncode(data, spec.ecPerBlock) });
    }
    for (let b = 0; b < spec.g2Blocks; b++) {
      const data = dataWords.slice(idx, idx + spec.g2Words); idx += spec.g2Words;
      blocks.push({ data, ec: rsEncode(data, spec.ecPerBlock) });
    }
    // Interleave data codewords column-by-column, then EC codewords column-by-column.
    const out: number[] = [];
    const maxData = Math.max(...blocks.map((bl) => bl.data.length));
    for (let i = 0; i < maxData; i++) for (const bl of blocks) if (i < bl.data.length) out.push(bl.data[i]);
    const maxEc = Math.max(...blocks.map((bl) => bl.ec.length));
    for (let i = 0; i < maxEc; i++) for (const bl of blocks) if (i < bl.ec.length) out.push(bl.ec[i]);
    return out;
  }

  // Lay the modules out on the grid: function patterns, then the data zig-zag.
  function buildMatrix(finalWords: number[], version: number): boolean[][] {
    const n = sizeFor(version);
    // grid[r][c]: true = dark. reserved[r][c]: true = a function module (don't put data here).
    const grid: boolean[][] = Array.from({ length: n }, () => new Array(n).fill(false));
    const reserved: boolean[][] = Array.from({ length: n }, () => new Array(n).fill(false));

    const set = (r: number, c: number, dark: boolean) => { grid[r][c] = dark; reserved[r][c] = true; };

    // A finder pattern: the big 7×7 square in three corners.
    function finder(top: number, left: number) {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const rr = top + r, cc = left + c;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inner && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, dark);
      }
    }
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0);

    // Timing patterns: the dotted lines linking the finders.
    for (let i = 8; i < n - 8; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }

    // Alignment patterns: small 5×5 squares (none on v1).
    const centers = ALIGN_POS[version - 1];
    for (const r of centers) for (const c of centers) {
      // Skip the three that overlap the finder corners.
      if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;   // ring + centre dot
        set(r + dr, c + dc, dark);
      }
    }

    // The dark module that's always present.
    set(n - 8, 8, true);

    // Reserve the format-information areas (filled in after masking is chosen).
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) { reserved[8][i] = true; reserved[i][8] = true; }
    }
    for (let i = 0; i < 8; i++) { reserved[8][n - 1 - i] = true; reserved[n - 1 - i][8] = true; }

    // Reserve version-information areas for versions 7+ (6×3 blocks near two finders).
    if (version >= 7) {
      for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
        reserved[i][n - 11 + j] = true;
        reserved[n - 11 + j][i] = true;
      }
    }

    // --- place the data bits in the QR zig-zag, applying mask pattern 0. -------
    // Mask 0 flips a module when (row + col) % 2 === 0.
    const bitAt = (k: number): number => {
      const byte = finalWords[k >> 3];
      if (byte === undefined) return 0;
      return (byte >> (7 - (k & 7))) & 1;
    };
    let bit = 0;
    let upward = true;
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col = 5;   // skip the vertical timing column
      for (let i = 0; i < n; i++) {
        const row = upward ? n - 1 - i : i;
        for (let dc = 0; dc < 2; dc++) {
          const c = col - dc;
          if (reserved[row][c]) continue;
          let dark = bitAt(bit) === 1;
          if ((row + c) % 2 === 0) dark = !dark;   // mask pattern 0
          grid[row][c] = dark;
          bit++;
        }
      }
      upward = !upward;
    }

    // --- write the format information (ECC level L, mask 0). -------------------
    const fmt = FORMAT_L[0];
    const fbit = (i: number): boolean => ((fmt >> i) & 1) === 1;
    // Around the top-left finder.
    for (let i = 0; i <= 5; i++) grid[8][i] = fbit(i);
    grid[8][7] = fbit(6);
    grid[8][8] = fbit(7);
    grid[7][8] = fbit(8);
    for (let i = 9; i <= 14; i++) grid[14 - i][8] = fbit(i);
    // The duplicate copy near the other two finders.
    for (let i = 0; i <= 7; i++) grid[n - 1 - i][8] = fbit(i);
    for (let i = 8; i <= 14; i++) grid[8][n - 15 + i] = fbit(i);

    return grid;
  }

  // Top-level: turn text into a QR module matrix. Throws if the text is too long.
  function encodeQR(text: string, site: Site): boolean[][] {
    const bytes = [...Buffer.from(text, "utf8")];
    // Find the smallest version (1–10) whose byte-mode capacity fits.
    for (let v = 1; v <= 10; v++) {
      const spec = SPECS[v - 1];
      const lenBits = v <= 9 ? 8 : 16;
      const headerBits = 4 + lenBits;
      const dataBits = headerBits + bytes.length * 8;
      if (dataBits <= spec.totalData * 8) {
        const dataWords = buildDataCodewords(bytes, v, spec);
        const finalWords = buildFinalCodewords(dataWords, spec);
        return buildMatrix(finalWords, v);
      }
    }
    throw new LangError("Runtime", "that text is too long to fit in a QR code.", site?.line ?? 1, site?.col ?? 1,
      "Try something shorter — a link or a short note works great.");
  }

  // Print a QR matrix to the terminal using stacked half-block characters: each
  // text line shows TWO module rows (top half / bottom half), so the code stays
  // roughly square. We add a 4-module quiet zone (white border) so scanners lock on.
  function printQR(matrix: boolean[][]): void {
    const n = matrix.length;
    const quiet = 4;
    const dark = (r: number, c: number): boolean => {
      if (r < 0 || r >= n || c < 0 || c >= n) return false;   // quiet zone = light
      return matrix[r][c];
    };
    const lines: string[] = [];
    // Step two module-rows at a time. Dark = "ink"; in the terminal, a dark module
    // is a light glyph on a dark background, so we map dark->space and light->block
    // for good contrast on most terminals... we instead use: top/bottom blocks.
    for (let r = -quiet; r < n + quiet; r += 2) {
      let line = "";
      for (let c = -quiet; c < n + quiet; c++) {
        const top = dark(r, c);
        const bottom = dark(r + 1, c);
        // A dark module should render as a filled cell. Use half blocks so each
        // character carries the top and bottom module independently.
        if (top && bottom) line += "█";
        else if (top && !bottom) line += "▀";
        else if (!top && bottom) line += "▄";
        else line += " ";
      }
      lines.push(line);
    }
    console.log("");
    for (const l of lines) console.log(l);
    console.log("");
  }

  // --- 1-bit PNG writer (zero-dependency, node:zlib for the deflate). ---------
  // Build a CRC-32 table once for PNG chunk checksums.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function pngChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  // Render the QR matrix to a scaled, bordered grayscale PNG and return its bytes.
  // We use 8-bit grayscale (simple and universally supported) with a chosen scale.
  function qrToPng(matrix: boolean[][], scale = 8, quiet = 4): Buffer {
    const n = matrix.length;
    const dim = (n + quiet * 2) * scale;   // final pixel size per side

    // One scanline per pixel row: a filter byte (0) followed by one byte per pixel.
    const rowBytes = dim;
    const raw = Buffer.alloc((rowBytes + 1) * dim);
    let o = 0;
    for (let py = 0; py < dim; py++) {
      raw[o++] = 0;   // filter type "none"
      const my = Math.floor(py / scale) - quiet;
      for (let px = 0; px < dim; px++) {
        const mx = Math.floor(px / scale) - quiet;
        const isDark = my >= 0 && my < n && mx >= 0 && mx < n && matrix[my][mx];
        raw[o++] = isDark ? 0x00 : 0xff;   // dark module = black, else white
      }
    }

    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(dim, 0);   // width
    ihdr.writeUInt32BE(dim, 4);   // height
    ihdr[8] = 8;                  // bit depth
    ihdr[9] = 0;                  // color type 0 = grayscale
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // compression / filter / interlace
    const idat = deflateSync(raw);
    return Buffer.concat([
      sig,
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", idat),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
  }

  // ===========================================================================
  //  THE BUILTINS
  // ===========================================================================

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // share(file) -> url : let your phone download ONE file. The server sets
    // Content-Disposition: attachment so the browser saves it instead of showing it.
    share: (args, site) => {
      const name = stringify(args[0] ?? NONE).trim();
      if (!name) throw new LangError("Runtime", "share needs a file to share.", site?.line ?? 1, site?.col ?? 1, 'Try: share("photo.jpg")');
      const path = resolve(interp.programDir, name);
      let size: number;
      try { size = statSync(path).size; }
      catch { throw new LangError("Runtime", "I couldn't find the file '" + name + "'.", site?.line ?? 1, site?.col ?? 1, "Put it next to your program, or check the name."); }

      const downloadName = basename(path);
      const server = createServer((_req, res) => {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(size),
          "Content-Disposition": 'attachment; filename="' + downloadName.replace(/"/g, "") + '"',
        });
        createReadStream(path).pipe(res);
      });
      return addServer("share " + downloadName, server);
    },

    // serve(folder) -> url : browse a whole folder from your phone. "/" lists the
    // files as links; clicking one streams it with a guessed content-type.
    serve: (args, site) => {
      const name = stringify(args[0] ?? NONE).trim();
      if (!name) throw new LangError("Runtime", "serve needs a folder to share.", site?.line ?? 1, site?.col ?? 1, 'Try: serve("my-pictures")');
      const dir = resolve(interp.programDir, name);
      try { if (!statSync(dir).isDirectory()) throw 0; }
      catch { throw new LangError("Runtime", "'" + name + "' isn't a folder I can find.", site?.line ?? 1, site?.col ?? 1, "Give serve() a folder next to your program."); }

      const server = createServer((req, res) => {
        // Decode the request path and keep it inside the shared folder (no "..").
        let rel = "";
        try { rel = decodeURIComponent((req.url ?? "/").split("?")[0]); } catch { rel = "/"; }
        rel = rel.replace(/^\/+/, "");

        if (rel === "") {
          // The index page: a tidy list of links.
          let items: string[] = [];
          try { items = readdirSync(dir); } catch { /* show an empty list */ }
          const links = items
            .filter((f) => { try { return statSync(join(dir, f)).isFile(); } catch { return false; } })
            .map((f) => '<li><a href="/' + encodeURIComponent(f) + '">' + esc(f) + "</a></li>")
            .join("\n");
          const page =
            "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
            "<title>" + esc(basename(dir)) + "</title>" +
            "<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem}" +
            "h1{font-size:1.3rem}li{margin:.4rem 0;font-size:1.1rem}a{color:#2a7}</style>" +
            "<h1>🌱 " + esc(basename(dir)) + "</h1>" +
            (links ? "<ul>" + links + "</ul>" : "<p>This folder is empty.</p>");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(page);
          return;
        }

        // A file request: only serve a plain file directly inside the folder.
        const safe = basename(rel);
        const filePath = join(dir, safe);
        let st;
        try { st = statSync(filePath); } catch { st = null; }
        if (!st || !st.isFile()) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found.");
          return;
        }
        res.writeHead(200, { "Content-Type": contentTypeFor(safe), "Content-Length": String(st.size) });
        createReadStream(filePath).pipe(res);
      });
      return addServer("serve " + basename(dir), server);
    },

    // sharetext(text) -> url : a minimal page showing some text with a Copy button.
    // Great for handing your phone a password, a link, or a note.
    sharetext: (args, site) => {
      const text = stringify(args[0] ?? NONE);
      const safe = esc(text);
      const server = createServer((_req, res) => {
        const page =
          "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
          "<title>Shared text</title>" +
          "<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem}" +
          "pre{white-space:pre-wrap;word-break:break-word;background:#f5f5f5;padding:1rem;border-radius:8px;font-size:1.1rem}" +
          "button{font-size:1rem;padding:.6rem 1.2rem;border:0;border-radius:8px;background:#2a7;color:#fff;cursor:pointer}" +
          "#ok{margin-left:.6rem;color:#2a7}</style>" +
          "<h1>🌱 Shared text</h1>" +
          "<pre id=t>" + safe + "</pre>" +
          "<button onclick=\"copyIt()\">Copy</button><span id=ok></span>" +
          "<script>function copyIt(){var t=document.getElementById('t').innerText;" +
          "(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject())" +
          ".then(function(){document.getElementById('ok').textContent='Copied!'})" +
          ".catch(function(){var r=document.createRange();r.selectNode(document.getElementById('t'));" +
          "var s=getSelection();s.removeAllRanges();s.addRange(r);try{document.execCommand('copy');" +
          "document.getElementById('ok').textContent='Copied!'}catch(e){document.getElementById('ok').textContent='Select and copy.'}});}</script>";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page);
      });
      return addServer("sharetext", server);
    },

    // sendphone(topic, msg) -> nothing : send a push notification to your phone in
    // ONE shot via ntfy.sh — a free, no-account push service. Install the "ntfy"
    // app, subscribe to your topic, and you'll get the message instantly.
    sendphone: (args, site) => {
      const topic = stringify(args[0] ?? NONE).trim();
      const msg = stringify(args[1] ?? NONE);
      if (!topic) throw new LangError("Runtime", "sendphone needs a topic name.", site?.line ?? 1, site?.col ?? 1, 'Pick any private word, like: sendphone("toms-alerts-92", "Hi!")');
      if (!msg.trim()) throw new LangError("Runtime", "sendphone needs a message to send.", site?.line ?? 1, site?.col ?? 1, 'Try: sendphone("' + topic + '", "Dinner is ready!")');
      runNode(
        "(async()=>{try{const r=await fetch('https://ntfy.sh/'+encodeURIComponent(process.argv[1]),{method:'POST',body:process.argv[2]});if(!r.ok)throw new Error('the service replied with status '+r.status);process.stdout.write('ok');}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
        [topic, msg],
        site,
      );
      return NONE;
    },

    // qr(text)        -> nothing  : print a scannable QR code in the terminal.
    // qr(text, file)  -> filename : save it as a black-and-white PNG you can show.
    // Built entirely in this file — no internet needed.
    qr: (args, site) => {
      const text = stringify(args[0] ?? NONE);
      if (!text) throw new LangError("Runtime", "qr needs some text or a link.", site?.line ?? 1, site?.col ?? 1, 'Try: qr("https://example.com")');
      const matrix = encodeQR(text, site);

      const fileArg = args[1] != null ? stringify(args[1]).trim() : "";
      if (!fileArg) {
        printQR(matrix);
        return NONE;
      }
      const name = /\.png$/i.test(fileArg) ? fileArg : fileArg + ".png";
      const png = qrToPng(matrix);
      try { writeFileSync(resolve(interp.programDir, name), png); }
      catch (e) { throw new LangError("Runtime", "I couldn't save the QR picture: " + (e instanceof Error ? e.message : String(e)), site?.line ?? 1, site?.col ?? 1, "Pick a different filename."); }
      return name;
    },
  };

  // --- background lifecycle ----------------------------------------------------

  // Bind one server to a port, bumping past anything already in use, then announce.
  function listenWithBump(job: Job): void {
    const tryPort = (port: number) => {
      job.server.removeAllListeners("error");
      job.server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          tryPort(port + 1);   // that port's taken — try the next one
        } else {
          console.error("🌐 sharing: couldn't start a server — " + err.message);
        }
      });
      job.server.listen(port, () => {
        job.port = port;
        console.log("   " + job.label + " -> http://" + localIp() + ":" + port + "/");
      });
    };
    tryPort(job.port);
  }

  const start = (): void => {
    if (servers.length === 0) return;
    console.log("🌐 Sharing is live (open these on your phone, same Wi-Fi):");
    for (const job of servers) listenWithBump(job);
    console.log("   (press Ctrl+C to stop)");
  };

  return {
    names: ["share", "serve", "sharetext", "sendphone", "qr"],
    builtins,
    isActive: () => servers.length > 0,
    start,
  };
}
