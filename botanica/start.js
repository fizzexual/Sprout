// start.js — launches Botanica by calling electron.exe directly.
//
// We avoid `electron .` (npm's batch shim) because that shim breaks when the
// folder path contains parentheses, e.g. "New folder (25)" — the ')' prematurely
// closes an IF(...) block inside npm's generated electron.cmd. Calling the real
// electron.exe sidesteps the whole problem.

const { spawn } = require("node:child_process");
const path = require("node:path");
const electronExe = require("electron"); // resolves to the electron.exe path

const child = spawn(electronExe, [path.join(__dirname, "."), ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: __dirname,
});
child.on("close", (code) => process.exit(code ?? 0));
