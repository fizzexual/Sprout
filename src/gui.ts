// gui.ts — Sprout's little GUI toolkit.
//
// A Sprout program builds a window by calling these built-in functions:
//
//   window("Title")            set the window title
//   label("id", "text")        add a text label (call again to update it)
//   button("text", "taskName") add a button that runs a task when clicked
//   field("id", "hint")        add a text box the user can type in
//   textof("id")               read what's currently in a field  -> text
//
// The widgets are collected into this GuiModel; gui-server.ts renders them in
// the browser and routes button clicks back to the interpreter.

import { LangError } from "./errors.ts";
import type { Value } from "./values.ts";
import { NONE, stringify, typeName } from "./values.ts";

export interface Widget {
  kind: "label" | "button" | "field";
  id: string;
  text: string;
  placeholder?: string;
  onClick?: string; // for buttons: the name of the task to run when clicked
}

export interface GuiModel {
  title: string;
  widgets: Widget[];
  used: boolean; // did the program call any GUI function?
}

export function newGui(): GuiModel {
  return { title: "Sprout App", widgets: [], used: false };
}

export const GUI_BUILTINS = ["window", "label", "button", "field", "textof"];

export function isGuiBuiltin(name: string): boolean {
  return GUI_BUILTINS.includes(name);
}

interface Site {
  line: number;
  col: number;
}

export function callGuiBuiltin(gui: GuiModel, name: string, args: Value[], site: Site): Value {
  gui.used = true;
  switch (name) {
    case "window": {
      need(name, args, 1, site);
      gui.title = stringify(args[0]);
      return NONE;
    }
    case "label": {
      need(name, args, 2, site);
      upsertLabel(gui, asId(args[0], name, site), stringify(args[1]));
      return NONE;
    }
    case "button": {
      need(name, args, 2, site);
      const text = stringify(args[0]);
      const task = asId(args[1], name, site);
      gui.widgets.push({ kind: "button", id: "button-" + gui.widgets.length, text, onClick: task });
      return NONE;
    }
    case "field": {
      need(name, args, 1, site);
      const id = asId(args[0], name, site);
      const placeholder = args.length > 1 ? stringify(args[1]) : "";
      if (!find(gui, id)) gui.widgets.push({ kind: "field", id, text: "", placeholder });
      return NONE;
    }
    case "textof": {
      need(name, args, 1, site);
      const w = find(gui, asId(args[0], name, site));
      return w ? w.text : "";
    }
    default:
      return NONE;
  }
}

function need(name: string, args: Value[], n: number, site: Site): void {
  if (args.length < n) {
    throw new LangError(
      "Type",
      `'${name}' needs ${n} ${n === 1 ? "value" : "values"}, but you gave ${args.length}.`,
      site.line,
      site.col,
      exampleFor(name),
    );
  }
}

function asId(v: Value, name: string, site: Site): string {
  if (typeof v !== "string") {
    throw new LangError(
      "Type",
      `'${name}' needs a name in quotes, but got ${typeName(v)}.`,
      site.line,
      site.col,
      exampleFor(name),
    );
  }
  return v;
}

function find(gui: GuiModel, id: string): Widget | undefined {
  return gui.widgets.find((w) => w.id === id);
}

function upsertLabel(gui: GuiModel, id: string, text: string): void {
  const existing = find(gui, id);
  if (existing && existing.kind === "label") existing.text = text;
  else gui.widgets.push({ kind: "label", id, text });
}

function exampleFor(name: string): string {
  if (name === "window") return 'Like: window("My App")';
  if (name === "label") return 'Like: label("greeting", "Hello!")';
  if (name === "button") return 'Like: button("Click me", "whenClicked")  (2nd value is a task name)';
  if (name === "field") return 'Like: field("name", "Type here")';
  return 'Like: textof("name")';
}
