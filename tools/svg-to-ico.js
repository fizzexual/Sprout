// svg-to-ico.js — converts the project's SVG logos into Windows .ico files,
// using Electron's bundled Chromium to rasterize the SVG (System.Drawing can't
// render SVG). Run it with Electron:
//   <botanica>/node_modules/electron/dist/electron.exe tools/svg-to-ico.js

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SIZE = 256;
const base = path.join(__dirname, "..");

const jobs = [
  ["images/spt-file-icon.svg", "images/sprout-file.ico", "images/_preview-sprout.png"],
  ["images/bloom-icon.svg", "images/bloom-file.ico", "images/_preview-bloom.png"],
  ["images/botanica-icon.svg", "botanica/icon.ico", "images/_preview-botanica.png"],
];

function pngToIco(png) {
  const h = Buffer.alloc(22);
  h.writeUInt16LE(0, 0); // reserved
  h.writeUInt16LE(1, 2); // type = icon
  h.writeUInt16LE(1, 4); // image count
  h.writeUInt8(0, 6); // width (0 = 256)
  h.writeUInt8(0, 7); // height (0 = 256)
  h.writeUInt8(0, 8); // palette
  h.writeUInt8(0, 9); // reserved
  h.writeUInt16LE(1, 10); // planes
  h.writeUInt16LE(32, 12); // bpp
  h.writeUInt32LE(png.length, 14); // size
  h.writeUInt32LE(22, 18); // offset
  return Buffer.concat([h, png]);
}

async function renderSvg(win, svg) {
  const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
  const code = `new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = ${SIZE}; c.height = ${SIZE};
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, ${SIZE}, ${SIZE});
      const s = Math.min(${SIZE} / img.naturalWidth, ${SIZE} / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s;
      ctx.drawImage(img, (${SIZE} - w) / 2, (${SIZE} - h) / 2, w, h);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject('svg failed to load');
    img.src = ${JSON.stringify(dataUrl)};
  })`;
  const out = await win.webContents.executeJavaScript(code, true);
  return Buffer.from(out.split(",")[1], "base64");
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: SIZE, height: SIZE });
  await win.loadURL("data:text/html,<html><body></body></html>");
  for (const [svgRel, icoRel, pngRel] of jobs) {
    const svg = fs.readFileSync(path.join(base, svgRel), "utf8");
    const png = await renderSvg(win, svg);
    fs.writeFileSync(path.join(base, icoRel), pngToIco(png));
    fs.writeFileSync(path.join(base, pngRel), png); // preview, for verification
    console.log("wrote " + icoRel);
  }
  app.quit();
});
