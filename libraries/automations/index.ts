// libraries/automations/index.ts — make Sprout do things on a schedule, control
// the PC, react to events, and run on startup.
//
//   use "automations"
//
// The library is split into topic files so each part is easy to read:
//   scheduling.ts  wait / now / today / weekday / every / after / at / watch / stop
//                  + countdown / alarm / snooze / on_days / on_first / at_sunrise...
//   startup.ts     run_on_startup / start_with_pc (run things at login)
//   apps.ts        launch / running / closeapp
//   system.ts      volume / mute / shutdown / lock / darkmode / wallpaper / say...
//   macros.ts      type / press / screenshot / movemouse / click / clipboard
//   triggers.ts    when_idle / on_usb / on_open / on_wifi / on_low_battery...
//   routines.ts    workmode / pomodoro / morning / bedtime / routine (compose it all)
//
// This file just wires the topic modules together.

import type { Interpreter } from "../../src/interpreter.ts";
import type { Value } from "../../src/values.ts";
import { register as scheduling } from "./scheduling.ts";
import { register as startup } from "./startup.ts";
import { register as apps } from "./apps.ts";
import { register as system } from "./system.ts";
import { register as macros } from "./macros.ts";
import { register as triggers } from "./triggers.ts";
import { register as routines } from "./routines.ts";

type Site = { line: number; col: number };
type Builtin = (args: Value[], site?: Site) => Value;
interface Module { names: string[]; builtins: Record<string, Builtin>; isActive?: () => boolean; start?: () => void }

export function create(interp: Interpreter) {
  // Order matters for the rare shared name (e.g. clipboard, say): the first
  // module listed wins.
  const mods: Module[] = [scheduling(interp), startup(interp), apps(interp), system(interp), macros(interp), triggers(interp), routines(interp)];
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
