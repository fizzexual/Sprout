// net.ts — the internet for Sprout: get("url") and post("url", body).
//
// Sprout's interpreter is synchronous, but HTTP is async, so we run the request
// in a short-lived Node subprocess and wait for it (spawnSync). This keeps the
// language simple — get(...) just returns the text — with no dependencies.

import { spawnSync } from "node:child_process";
import { LangError } from "../lang/errors.ts";

export interface Net {
  get(url: string): string;
  post(url: string, body: string): string;
}

export const NET_BUILTINS = ["get", "post"];

export function nodeNet(): Net {
  return {
    get: (url) => request("GET", url, ""),
    post: (url, body) => request("POST", url, body),
  };
}

function request(method: string, url: string, body: string): string {
  const script =
    "(async()=>{try{" +
    "const m=process.argv[2];const o={method:m};" +
    "if(m==='POST'){o.body=process.argv[3]||'';o.headers={'Content-Type':'text/plain'};}" +
    "const r=await fetch(process.argv[1],o);" +
    "process.stdout.write(await r.text());" +
    "}catch(e){process.stderr.write(String((e&&e.message)||e));process.exit(2);}})()";

  const res = spawnSync(process.execPath, ["-e", script, url, method, body], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 20000,
  });
  if (res.error) throw new Error(res.error.message);
  if (res.status !== 0) throw new Error((res.stderr || "").trim() || "the request failed");
  return res.stdout;
}

// Used when there's no internet capability (e.g. in tests, by default).
export function noNet(): Net {
  const fail = (): never => {
    throw new LangError("Runtime", "The internet isn't available here.", 1, 1, "Run your program with 'sprout run' to use get/post.");
  };
  return { get: fail, post: fail };
}
