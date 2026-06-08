// libraries/networking/devices.ts — discover and poke at the gadgets on your
// local network (your home/office Wi-Fi). All zero-dependency: we read the
// computer's own ARP table, ask Windows for the router, look up names, ping,
// and even send a "Wake-on-LAN" magic packet to switch a sleeping PC on.
//
//   use "networking/devices"
//   show "Things on my network:"
//   for each d in devices():
//       show "  •", d
//   show "My router is", router()
//   show "The TV is", isup("192.168.1.42") ? "awake" : "asleep"
//   wake("aa-bb-cc-dd-ee-ff")    -- nudge a sleeping computer awake
//
// Sprout's interpreter is synchronous, so anything that needs Node's async UDP
// (Wake-on-LAN) runs in a tiny short-lived Node subprocess via spawnSync — the
// same trick the rest of the networking library uses for the web.

import { NONE, stringify, SList } from "../../src/values.ts";
import type { Value } from "../../src/values.ts";
import type { Interpreter } from "../../src/interpreter.ts";
import { LangError } from "../../src/errors.ts";
import { spawnSync } from "node:child_process";

type Site = { line: number; col: number } | undefined;

export function register(interp: Interpreter) {
  // ---------------------------------------------------------------------------
  // Little shared helpers
  // ---------------------------------------------------------------------------

  // Run a tiny Node script (used for the Wake-on-LAN UDP socket, which has to be
  // async) and hand back its stdout. Throws a friendly error if it goes wrong.
  function runNode(script: string, args: string[], site: Site): string {
    const res = spawnSync(process.execPath, ["-e", script, ...args], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 20000,
    });
    if (res.error) {
      throw new LangError("Runtime", "Network problem: " + res.error.message, site?.line ?? 1, site?.col ?? 1, "Check your connection.");
    }
    if (res.status !== 0) {
      throw new LangError("Runtime", "Network problem: " + ((res.stderr || "").trim() || "failed"), site?.line ?? 1, site?.col ?? 1, "Check the address.");
    }
    return res.stdout ?? "";
  }

  // Does this text look like a plain IPv4 address (four 0–255 numbers)?
  function isIPv4(s: string): boolean {
    const m = s.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    return m.slice(1).every((p) => Number(p) >= 0 && Number(p) <= 255);
  }

  // We hide "everyone" addresses — multicast (224–239.*), broadcast
  // (255.255.255.255 or anything ending in .255), and the all-FF MAC — because
  // those aren't real, individual gadgets you'd want to list.
  function isEveryoneAddress(ip: string, mac: string): boolean {
    const first = Number(ip.split(".")[0]);
    if (first >= 224 && first <= 239) return true;          // multicast
    if (ip === "255.255.255.255") return true;              // limited broadcast
    if (ip.endsWith(".255")) return true;                   // subnet broadcast
    const m = mac.toLowerCase().replace(/[-:]/g, "");
    if (m === "ffffffffffff") return true;                  // broadcast MAC
    if (m.startsWith("01005e") || m.startsWith("0100")) return true; // multicast MACs
    return false;
  }

  // Read this computer's ARP table — the list of "I've recently talked to this
  // IP, and here's its hardware (MAC) address" pairs the OS keeps. Each result
  // is { ip, mac }. We skip the multicast/broadcast "everyone" entries.
  function arpEntries(): { ip: string; mac: string }[] {
    const res = spawnSync("arp", ["-a"], { encoding: "utf8", timeout: 8000 });
    const text = (res.stdout || "") + "\n" + (res.stderr || "");
    const out: { ip: string; mac: string }[] = [];
    const seen = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      // Match an IPv4 address and a MAC like aa-bb-cc-dd-ee-ff on the same line.
      const ipm = line.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
      const macm = line.match(/\b([0-9a-fA-F]{2}([-:])[0-9a-fA-F]{2}(\2[0-9a-fA-F]{2}){4})\b/);
      if (!ipm || !macm) continue;
      const ip = ipm[1];
      const mac = macm[1];
      if (isEveryoneAddress(ip, mac)) continue;
      if (seen.has(ip)) continue;
      seen.add(ip);
      out.push({ ip, mac });
    }
    return out;
  }

  // Look up the friendly name for an IP (reverse DNS). Windows-only nicety; if
  // anything fails (or there's no name on record) we just give back the IP.
  function lookupName(ip: string): string {
    if (process.platform !== "win32") return ip;
    const res = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "[System.Net.Dns]::GetHostEntry('" + ip + "').HostName"],
      { encoding: "utf8", timeout: 4000 },
    );
    const name = (res.stdout || "").trim();
    return name.length > 0 ? name : ip;
  }

  // Ping an IP once and report whether we heard back (we look for "time=" in the
  // reply, which only appears on a successful round-trip).
  function pingOnce(ip: string): boolean {
    const isWin = process.platform === "win32";
    const args = isWin ? ["-n", "1", "-w", "1000", ip] : ["-c", "1", "-W", "1", ip];
    const res = spawnSync("ping", args, { encoding: "utf8", timeout: 4000 });
    const text = (res.stdout || "") + (res.stderr || "");
    return /time[=<]/i.test(text);
  }

  // ---------------------------------------------------------------------------
  // The builtins
  // ---------------------------------------------------------------------------

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // devices() -> a list of the gadgets on your network as
    // "192.168.1.20 (aa-bb-cc-dd-ee-ff)" strings.
    devices: () => {
      return new SList(arpEntries().map((e) => e.ip + " (" + e.mac + ")"));
    },

    // router() -> the address of your router (the box that connects you to the
    // internet), or nothing if it can't be found.
    router: () => {
      if (process.platform === "win32") {
        // Ask Windows for the default route's next hop (that's the router).
        const res = spawnSync(
          "powershell",
          ["-NoProfile", "-Command", "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop"],
          { encoding: "utf8", timeout: 8000 },
        );
        const hop = (res.stdout || "").trim();
        if (hop && isIPv4(hop)) return hop;

        // Fallback: dig the "Default Gateway" line out of ipconfig.
        const cfg = spawnSync("ipconfig", [], { encoding: "utf8", timeout: 8000 });
        for (const line of (cfg.stdout || "").split(/\r?\n/)) {
          if (/Default Gateway/i.test(line)) {
            const m = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
            if (m && isIPv4(m[1])) return m[1];
          }
        }
        return NONE;
      }

      // Non-Windows: parse the default route from `ip route` if available.
      const res = spawnSync("ip", ["route"], { encoding: "utf8", timeout: 8000 });
      const m = (res.stdout || "").match(/default via (\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
      return m && isIPv4(m[1]) ? m[1] : NONE;
    },

    // devicename(ip) -> the friendly name of the gadget at that IP (or the IP
    // itself if it has no name we can find).
    devicename: (args, site) => {
      const ip = stringify(args[0] ?? NONE).trim();
      if (!ip) {
        throw new LangError("Runtime", "devicename needs an address to look up.", site?.line ?? 1, site?.col ?? 1, 'Try: devicename("192.168.1.20")');
      }
      return lookupName(ip);
    },

    // isup(target) -> yes/no: is that device awake and reachable right now?
    // target can be an IP, or a device name (we'll find its IP for you).
    isup: (args, site) => {
      const target = stringify(args[0] ?? NONE).trim();
      if (!target) {
        throw new LangError("Runtime", "isup needs a device or address to check.", site?.line ?? 1, site?.col ?? 1, 'Try: isup("192.168.1.20") or isup("my-phone")');
      }
      // A plain IP? Ping it directly.
      if (isIPv4(target)) return pingOnce(target);

      // Otherwise treat it as a name: find the matching gadget on the network.
      const want = target.toLowerCase();
      for (const e of arpEntries()) {
        const name = lookupName(e.ip).toLowerCase();
        if (name.includes(want)) return pingOnce(e.ip);
      }
      return false;
    },

    // find(name) -> the IP of the named gadget on your network, or nothing if
    // there's no match. Great for "where did my phone end up today?".
    find: (args, site) => {
      const want = stringify(args[0] ?? NONE).trim().toLowerCase();
      if (!want) {
        throw new LangError("Runtime", "find needs a device name to look for.", site?.line ?? 1, site?.col ?? 1, 'Try: find("my-phone")');
      }
      for (const e of arpEntries()) {
        const name = lookupName(e.ip).toLowerCase();
        if (name.includes(want)) return e.ip;
      }
      return NONE;
    },

    // wake(mac) -> nudge a sleeping computer awake by sending a Wake-on-LAN
    // "magic packet" to its hardware (MAC) address. Returns nothing.
    // (The PC must have Wake-on-LAN turned on in its settings for this to work.)
    wake: (args, site) => {
      const raw = stringify(args[0] ?? NONE).trim();
      // Pull out exactly 12 hex digits from aa-bb-.. or aa:bb:.. (or run-together).
      const hex = raw.replace(/[-:\s]/g, "");
      if (!/^[0-9a-fA-F]{12}$/.test(hex)) {
        throw new LangError("Runtime", "That doesn't look like a hardware (MAC) address.", site?.line ?? 1, site?.col ?? 1, 'A MAC looks like "aa-bb-cc-dd-ee-ff". Use devices() to see them.');
      }

      // Send the magic packet from a tiny Node script so the async UDP socket
      // stays synchronous from Sprout's point of view. The packet is:
      //   6 bytes of 0xFF, then the 6-byte MAC repeated 16 times (102 bytes),
      // broadcast to 255.255.255.255 on the two usual Wake-on-LAN ports (9 & 7).
      const script =
        "const dgram=require('node:dgram');" +
        "const hex=process.argv[1];" +
        "const mac=Buffer.from(hex,'hex');" +
        "const packet=Buffer.alloc(102,0xff);" +    // first 6 bytes already 0xff
        "for(let i=0;i<16;i++){mac.copy(packet,6+i*6);}" +
        "const sock=dgram.createSocket('udp4');" +
        "sock.bind(()=>{sock.setBroadcast(true);" +
        "let left=2;" +
        "const done=()=>{if(--left<=0){sock.close();}};" +
        "sock.send(packet,0,packet.length,9,'255.255.255.255',e=>{done();});" +
        "sock.send(packet,0,packet.length,7,'255.255.255.255',e=>{done();});" +
        "});" +
        "sock.on('error',e=>{process.stderr.write(String(e&&e.message||e));process.exit(2);});";
      runNode(script, [hex], site);
      return NONE;
    },
  };

  return {
    names: ["devices", "router", "devicename", "isup", "find", "wake"],
    builtins,
    isActive: () => false,   // pure one-shots — no background work to keep alive
  };
}

// The library loader (src/cli.ts) calls `create`; the module contract names it
// `register`. They're the same factory, exported under both names.
export const create = register;
