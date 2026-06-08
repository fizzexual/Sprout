// libraries/networking/index.ts — friendly network tools for Sprout.
//
//   use "networking"
//
// The library is split into topic files so each part is easy to read:
//   info.ts        hostname / localip / myip / online / status / ping / download
//                  + diagnostics: speedtest, whereis, wifi, isopen, hops, whois...
//   blocking.ts    block / unblock / blocked + categories + block_until
//   devices.ts     devices / router / devicename / find / isup / wake (your LAN)
//   monitoring.ts  monitor / watchinternet / isdown / avgping / healthcheck / uptime
//   sharing.ts     share / serve / sharetext / sendphone / qr (send to your phone)
//
// This file just wires the topic modules together.

import type { Interpreter } from "../../src/interpreter.ts";
import type { Value } from "../../src/values.ts";
import { register as info } from "./info.ts";
import { register as blocking } from "./blocking.ts";
import { register as devices } from "./devices.ts";
import { register as monitoring } from "./monitoring.ts";
import { register as sharing } from "./sharing.ts";
import { register as web } from "./web.ts";
import { register as security } from "./security.ts";

type Site = { line: number; col: number };
type Builtin = (args: Value[], site?: Site) => Value;
interface Module { names: string[]; builtins: Record<string, Builtin>; isActive?: () => boolean; start?: () => void }

export function create(interp: Interpreter) {
  const mods: Module[] = [info(interp), blocking(interp), devices(interp), monitoring(interp), sharing(interp), web(interp), security(interp)];
  const names: string[] = [];
  const builtins: Record<string, Builtin> = {};
  for (const m of mods) {
    for (const n of m.names) {
      if (n in builtins) continue;   // first module to define a name wins
      names.push(n);
      builtins[n] = m.builtins[n];
    }
  }
  return {
    names,
    builtins,
    isActive: () => mods.some((m) => (m.isActive ? m.isActive() : false)),
    start: () => { for (const m of mods) if (m.start) m.start(); },
  };
}
