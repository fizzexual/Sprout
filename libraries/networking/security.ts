// libraries/networking/security.ts — network security & presence for Sprout.
//
//   use "networking/security"
//   when is_vpn():
//       show "Looks like you're on a VPN or proxy. 🛡️"
//   when captive_portal():
//       show "You need to sign in to this Wi-Fi first."
//   show "On the network right now:", whos_home()
//   show "Open ports on my router:", portscan("192.168.1.1")
//   show "Services running:", services("example.com")
//   use_dns("cloudflare")          ~ point this PC at 1.1.1.1 (needs admin)
//   show "Current DNS:", current_dns()
//   task someone_arrived():
//       show "New device joined:", newdevice()
//   on_new_device("someone_arrived")   ~ watch the network for new gadgets
//
// Sprout's interpreter is SYNCHRONOUS, so every network call here runs in a
// short-lived Node subprocess (spawnSync) and we wait for the answer — exactly
// how the built-in get()/post() work, with zero dependencies. The "who's home"
// and "new device" features read the ARP table (the list of gadgets your PC has
// recently talked to on the local network).

import { NONE, stringify, SList, SMap } from "../../src/interp/values.ts";
import type { Value } from "../../src/interp/values.ts";
import type { Interpreter } from "../../src/interp/interpreter.ts";
import { LangError } from "../../src/lang/errors.ts";
import { spawnSync } from "node:child_process";

type Site = { line: number; col: number } | undefined;

export function register(interp: Interpreter) {
  // --- helpers ---------------------------------------------------------------

  // Turn a raw Node/system error into Sprout's friendly voice.
  function netError(msg: string, site: Site): LangError {
    return new LangError("Runtime", "Network problem: " + msg, site?.line ?? 1, site?.col ?? 1, "Check your internet connection and the address.");
  }

  // Run a tiny async Node script and return its stdout (throws a friendly error).
  // In the -e script the FIRST passed arg is process.argv[1] (not [0]).
  function runNode(script: string, args: string[], site: Site): string {
    const res = spawnSync(process.execPath, ["-e", script, ...args], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 20000,
    });
    if (res.error) throw netError(res.error.message, site);
    if (res.status !== 0) throw netError((res.stderr || "").trim() || "the request failed", site);
    return res.stdout ?? "";
  }

  // Make sure we're on Windows for the Windows-only builtins.
  function needWindows(name: string, site: Site): void {
    if (process.platform !== "win32") {
      throw new LangError("Runtime", name + " works on Windows.", site?.line ?? 1, site?.col ?? 1, "These features read Windows-only network settings.");
    }
  }

  // Strip "https://" and any path so "https://router.lan/x" -> "router.lan".
  function bareHost(s: string): string {
    return s.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").trim();
  }

  // Read the ARP table — the list of gadgets your PC has recently talked to on
  // the local network — as [{ip, mac}]. We drop multicast/broadcast rows so only
  // real devices remain. Works on Windows and most Unix-likes ("arp -a").
  function arpEntries(): Array<{ ip: string; mac: string }> {
    const r = spawnSync("arp", ["-a"], { encoding: "utf8", timeout: 8000 });
    const out = (r.stdout || "") + "\n" + (r.stderr || "");
    const seen = new Set<string>();
    const list: Array<{ ip: string; mac: string }> = [];
    for (const line of out.split(/\r?\n/)) {
      // Each useful line has an IPv4 and a MAC (hyphen or colon separated).
      const ipM = line.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
      const macM = line.match(/\b([0-9A-Fa-f]{2}(?:[-:][0-9A-Fa-f]{2}){5})\b/);
      if (!ipM || !macM) continue;
      const ip = ipM[1];
      const mac = macM[1].replace(/:/g, "-").toUpperCase();
      // Skip broadcast and multicast: 255.255.255.255, the .255 broadcast, the
      // 224-239 multicast range, and the FF-FF-FF-FF-FF-FF / 01-00-5E... MACs.
      if (ip === "255.255.255.255" || ip.endsWith(".255")) continue;
      const firstOctet = Number(ip.split(".")[0]);
      if (firstOctet >= 224 && firstOctet <= 239) continue;
      if (mac === "FF-FF-FF-FF-FF-FF" || mac.startsWith("01-00-5E") || mac.startsWith("33-33")) continue;
      if (seen.has(mac)) continue;
      seen.add(mac);
      list.push({ ip, mac });
    }
    return list;
  }

  // Ask Windows for the friendly host name of an IP via a reverse DNS lookup.
  // Falls back to the IP itself when the name can't be found.
  function lookupName(ip: string): string {
    if (process.platform !== "win32") return ip;
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "try { [System.Net.Dns]::GetHostEntry('" + ip.replace(/'/g, "") + "').HostName } catch { '" + ip + "' }"],
      { encoding: "utf8", timeout: 6000 },
    );
    const name = (r.stdout || "").trim();
    return name ? name : ip;
  }

  // The curated list of common ports we scan when no range is given. These cover
  // the everyday services a beginner is likely to be looking for.
  const COMMON_PORTS = [21, 22, 23, 25, 53, 80, 110, 139, 143, 443, 445, 3000, 3306, 3389, 5432, 8080, 8443];

  // A friendly name for each well-known port (used by services()).
  const PORT_NAMES: Record<number, string> = {
    21: "FTP",
    22: "SSH",
    23: "Telnet",
    25: "Email (SMTP)",
    53: "DNS",
    80: "Web (HTTP)",
    110: "Email (POP3)",
    139: "Windows networking",
    143: "Email (IMAP)",
    443: "Secure web (HTTPS)",
    445: "Windows file sharing",
    3000: "Dev server",
    3306: "MySQL database",
    3389: "Remote Desktop",
    5432: "PostgreSQL database",
    8080: "Web (alt)",
    8443: "Secure web (alt)",
  };

  // The Node script (run in a subprocess) that try-connects to a list of ports
  // on a host in parallel and prints the open ones, space-separated. The ports
  // arrive as process.argv[1] (a space-separated string); the host is argv[2].
  const SCAN_SCRIPT =
    "const net=require('node:net');" +
    "const ports=(process.argv[1]||'').split(' ').filter(Boolean).map(Number);" +
    "const host=process.argv[2];" +
    "const open=[];let pending=ports.length;" +
    "if(pending===0){process.stdout.write('');process.exit(0);}" +
    "const finish=()=>{open.sort((a,b)=>a-b);process.stdout.write(open.join(' '));process.exit(0);};" +
    "for(const p of ports){" +
    "const s=net.connect(p,host);let settled=false;" +
    "const done=(ok)=>{if(settled)return;settled=true;try{s.destroy();}catch(e){}if(ok)open.push(p);if(--pending===0)finish();};" +
    "s.once('connect',()=>done(true));" +
    "s.once('error',()=>done(false));" +
    "setTimeout(()=>done(false),600);" +
    "}";

  // Work out which ports to scan: either the curated common list, or the
  // [start, end] range the caller asked for. Returns a clamped, sane list.
  function portsToScan(rangeArg: Value | undefined, site: Site): number[] {
    if (rangeArg == null || rangeArg instanceof SList === false) return COMMON_PORTS.slice();
    const items = (rangeArg as SList).items;
    const start = Math.round(Number(stringify(items[0] ?? NONE)));
    const end = Math.round(Number(stringify(items[1] ?? NONE)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end > 65535 || end < start) {
      throw new LangError("Runtime", "the port range should be a list like [start, end].", site?.line ?? 1, site?.col ?? 1, "Try: portscan(\"192.168.1.1\", [1, 1024])");
    }
    // Keep the scan friendly: cap the span so we never fire thousands of sockets.
    if (end - start > 2048) {
      throw new LangError("Runtime", "that port range is too big to scan quickly.", site?.line ?? 1, site?.col ?? 1, "Scan up to ~2000 ports at a time, e.g. [1, 1024].");
    }
    const list: number[] = [];
    for (let p = start; p <= end; p++) list.push(p);
    return list;
  }

  // Run a scan and return the open ports as numbers. Shared by portscan & services.
  function scanOpenPorts(host: string, ports: number[], site: Site): number[] {
    if (!host) return [];
    const out = runNode(SCAN_SCRIPT, [ports.join(" "), host], site).trim();
    if (!out) return [];
    return out.split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
  }

  // ===========================================================================
  // Background "new device" watching. Each on_new_device() call registers a job;
  // start() turns on a single polling loop that diffs the ARP table every ~25s.
  // ===========================================================================
  const jobs: Array<{ task: string }> = [];
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let lastJoiner: string = ""; // friendly "ip (name)" text of the most recent new device

  // --- the built-in functions ------------------------------------------------

  const builtins: Record<string, (args: Value[], site?: Site) => Value> = {
    // Are you behind a VPN, proxy, or hosting/datacenter network? -> yes / no
    // Asks a free IP-info service whether your public IP looks like a proxy or a
    // hosting provider (both are strong signs you're not on a plain home line).
    is_vpn: (_args, site) => {
      const out = runNode(
        "(async()=>{try{const r=await fetch('http://ip-api.com/json/?fields=status,proxy,hosting,mobile,isp,query');const j=await r.json();process.stdout.write((j.status==='success'&&(j.proxy===true||j.hosting===true))?'1':'0');}catch(e){process.stderr.write(String(e&&e.message||e));process.exit(2);}})()",
        [],
        site,
      ).trim();
      return out === "1";
    },

    // Is this Wi-Fi making you sign in on a web page first ("captive portal")? -> yes / no
    // We fetch Microsoft's connectivity-test URL: a clean connection returns the
    // exact text "Microsoft Connect Test"; a portal redirects us or replaces it.
    captive_portal: (_args, site) => {
      const out = runNode(
        "(async()=>{try{const r=await fetch('http://www.msftconnecttest.com/connecttest.txt',{redirect:'manual'});if((r.status>=300&&r.status<400)||r.type==='opaqueredirect'){process.stdout.write('1');return;}if(r.status===200){const b=(await r.text()).trim();process.stdout.write(b!=='Microsoft Connect Test'?'1':'0');return;}process.stdout.write('0');}catch(e){process.stdout.write('0');}})()",
        [],
        site,
      ).trim();
      return out === "1";
    },

    // Who's on the local network right now? -> a list of friendly device names.
    // Reads the ARP table and turns each gadget's IP into a name (or the IP itself).
    whos_home: () => {
      const names: Value[] = [];
      for (const { ip } of arpEntries()) {
        names.push(lookupName(ip));
      }
      return new SList(names);
    },

    // Which ports are open on a host? -> a list of open port numbers.
    //   portscan("192.168.1.1")           ~ scan the common ports
    //   portscan("192.168.1.1", [1, 1024]) ~ scan a custom range
    portscan: (args, site) => {
      const host = bareHost(stringify(args[0] ?? NONE));
      if (!host) throw new LangError("Runtime", "portscan needs a host to check.", site?.line ?? 1, site?.col ?? 1, 'Try: portscan("192.168.1.1")');
      const ports = portsToScan(args[1], site);
      const open = scanOpenPorts(host, ports, site);
      return new SList(open.map((p) => p as Value));
    },

    // What services are running on a host? -> a map of {friendly name: port}.
    // Scans the common ports and labels each open one (Web, SSH, Remote Desktop…).
    services: (args, site) => {
      const host = bareHost(stringify(args[0] ?? NONE));
      if (!host) throw new LangError("Runtime", "services needs a host to check.", site?.line ?? 1, site?.col ?? 1, 'Try: services("example.com")');
      const open = scanOpenPorts(host, COMMON_PORTS.slice(), site);
      const entries = new Map<string, Value>();
      for (const p of open) {
        const name = PORT_NAMES[p] ?? ("Port " + p);
        entries.set(name, p);
      }
      return new SMap(entries);
    },

    // Point this PC at a specific DNS provider. Needs administrator rights.
    //   use_dns("cloudflare")  ~ 1.1.1.1   use_dns("google") ~ 8.8.8.8
    //   use_dns("quad9")       ~ 9.9.9.9   use_dns("family") ~ 1.1.1.3 (filtered)
    //   use_dns("auto")        ~ go back to your router's automatic DNS
    //   use_dns("1.2.3.4")     ~ any custom server address
    // Note: setting DNS here is enforced at the OS level, so it also covers what
    // a browser's built-in "Secure DNS" (DNS-over-HTTPS) would otherwise sidestep.
    use_dns: (args, site) => {
      needWindows("use_dns", site);
      const raw = stringify(args[0] ?? NONE).trim().toLowerCase();
      if (!raw) throw new LangError("Runtime", "use_dns needs a provider or address.", site?.line ?? 1, site?.col ?? 1, 'Try: use_dns("cloudflare") or use_dns("auto")');

      // Friendly aliases -> real DNS server addresses.
      const ALIASES: Record<string, string> = {
        cloudflare: "1.1.1.1",
        google: "8.8.8.8",
        quad9: "9.9.9.9",
        family: "1.1.1.3",
      };
      const auto = raw === "auto" || raw === "automatic" || raw === "dhcp";
      let server = "";
      if (!auto) {
        server = ALIASES[raw] ?? raw;
        if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(server)) {
          throw new LangError("Runtime", "I don't recognise the DNS provider '" + raw + "'.", site?.line ?? 1, site?.col ?? 1, 'Try "cloudflare", "google", "quad9", "family", "auto", or an address like "1.2.3.4".');
        }
      }

      // Find the active interface name (the one with the default route).
      const ifName = activeInterfaceName(site);
      if (!ifName) throw new LangError("Runtime", "I couldn't find your active network connection.", site?.line ?? 1, site?.col ?? 1, "Make sure you're connected to a network, then try again.");

      // Apply the change with netsh. "static <ip>" sets it; "dhcp" returns to auto.
      const setArgs = auto
        ? ["interface", "ipv4", "set", "dnsservers", "name=" + ifName, "source=dhcp"]
        : ["interface", "ipv4", "set", "dns", "name=" + ifName, "static", server, "primary"];
      const r = spawnSync("netsh", setArgs, { encoding: "utf8", timeout: 10000 });
      const errText = ((r.stderr || "") + (r.stdout || "")).trim();
      if (r.status !== 0 || /denied|administrator|requires elevation|EPERM|EACCES/i.test(errText)) {
        throw new LangError("Runtime", "changing DNS needs administrator rights.", site?.line ?? 1, site?.col ?? 1, "Right-click your Sprout/terminal and choose \"Run as administrator\", then try again.");
      }
      // Flush the DNS cache so the new server takes effect right away.
      spawnSync("ipconfig", ["/flushdns"], { encoding: "utf8", timeout: 8000 });
      return NONE;
    },

    // What DNS servers is this PC using right now? -> a list of addresses.
    // Read-only, so it doesn't need administrator rights.
    current_dns: (_args, site) => {
      needWindows("current_dns", site);
      const r = spawnSync("netsh", ["interface", "ipv4", "show", "dnsservers"], { encoding: "utf8", timeout: 8000 });
      const text = (r.stdout || "") + "\n" + (r.stderr || "");
      const servers: Value[] = [];
      const seen = new Set<string>();
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
        if (m && !seen.has(m[1])) { seen.add(m[1]); servers.push(m[1]); }
      }
      return new SList(servers);
    },

    // Run a task whenever a brand-new device joins your local network.
    //   on_new_device("someone_arrived")
    // The watcher starts when your program finishes (so Sprout keeps running).
    on_new_device: (args, site) => {
      const task = stringify(args[0] ?? NONE).trim();
      if (!task) throw new LangError("Runtime", "on_new_device needs a task name to run.", site?.line ?? 1, site?.col ?? 1, 'Define a task, then: on_new_device("someone_arrived")');
      jobs.push({ task });
      return NONE;
    },

    // The most recent new device that joined, as "ip (name)" — or nothing yet.
    // Handy inside the task you gave to on_new_device.
    newdevice: () => (lastJoiner ? lastJoiner : NONE),
  };

  // Resolve the name of the network interface carrying the default route, so
  // use_dns() targets the connection you're actually online through. Tries the
  // modern Get-NetRoute first, then falls back to parsing "netsh interface show".
  function activeInterfaceName(site: Site): string {
    // Preferred: the interface alias on the 0.0.0.0/0 default route.
    const ps = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).InterfaceAlias"],
      { encoding: "utf8", timeout: 8000 },
    );
    const alias = (ps.stdout || "").trim();
    if (alias) return alias;

    // Fallback: the first "Connected" interface from netsh's interface list.
    const r = spawnSync("netsh", ["interface", "show", "interface"], { encoding: "utf8", timeout: 8000 });
    for (const line of (r.stdout || "").split(/\r?\n/)) {
      // Columns: Admin State | State | Type | Interface Name
      if (/\bConnected\b/i.test(line)) {
        const cols = line.trim().split(/\s{2,}/);
        const name = cols[cols.length - 1];
        if (name && !/Interface Name/i.test(name)) return name.trim();
      }
    }
    return "";
  }

  // ===========================================================================
  // start() — turn the registered "new device" jobs into one polling loop.
  // We baseline the set of MACs already on the network, then every ~25s re-read
  // the ARP table; any MAC we hadn't seen is a new gadget joining.
  // ===========================================================================
  const start = (): void => {
    if (jobs.length === 0) return;

    // Run a task, turning any error into a friendly note instead of crashing the loop.
    const run = (task: string): void => {
      try { interp.runTask(task); }
      catch (e) { console.error("⚡ on_new_device '" + task + "' had a problem: " + (e instanceof Error ? e.message : String(e))); }
    };

    // Seed with whoever's already here so we only fire for genuinely NEW devices.
    const known = new Set<string>(arpEntries().map((e) => e.mac));

    timers.push(setInterval(() => {
      for (const { ip, mac } of arpEntries()) {
        if (known.has(mac)) continue;
        known.add(mac);
        // Remember a friendly description for newdevice() to report.
        const name = lookupName(ip);
        lastJoiner = name && name !== ip ? ip + " (" + name + ")" : ip;
        for (const j of jobs) run(j.task);
      }
    }, 25000));

    console.log("⚡ Watching the network for new devices (press Ctrl+C to stop).");
  };

  return {
    names: [
      "is_vpn",
      "captive_portal",
      "whos_home",
      "portscan",
      "services",
      "use_dns",
      "current_dns",
      "on_new_device",
      "newdevice",
    ],
    builtins,
    isActive: () => jobs.length > 0,
    start,
  };
}
