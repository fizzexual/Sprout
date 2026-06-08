# networking: security & presence 🛡️

This part of the **networking** library helps you keep an eye on your network: is something fishy about your connection, who's sharing your Wi-Fi, what's listening on a machine, and which DNS servers your PC is pointed at. It reads things your computer already knows — your **ARP table** (the list of gadgets you've recently talked to), a couple of free internet check- pages, and Windows' own network settings — so there's nothing extra to install. Add it with:

```sprout
use "networking"
```

After that, every function below works just like Sprout's built-in ones.

> **Some of these are Windows-only.** `use_dns` and `current_dns` read Windows network settings, and friendly device names come from a Windows lookup. The rest (`is_vpn`, `captive_portal`, `whos_home`, `portscan`, `services`, `on_new_device`) work on most systems, but this page is happiest on Windows.

## Functions

| Function | What it does | Example |
| --- | --- | --- |
| `is_vpn()` | `yes`/`no`: does your connection look like a VPN, proxy, or datacenter line? (Asks a free IP-info service — needs internet.) | `when is_vpn(): show "On a VPN 🛡️"` |
| `captive_portal()` | `yes`/`no`: is this Wi-Fi making you sign in on a web page first? (Checks Microsoft's connectivity URL — needs internet.) | `when captive_portal(): show "Sign in first"` |
| `whos_home()` | A list of the gadgets on your network right now, each as a friendly name (or its IP if it has no name). | `show whos_home()` |
| `portscan("host")` | A list of the open port numbers on a host. Scans common ports, or a `[start, end]` range you give. | `show portscan("192.168.1.1")` |
| `services("host")` | A map of `{friendly name: port}` for the services running on a host (Web, SSH, Remote Desktop…). | `show services("example.com")` |
| `use_dns("name")` | Point this PC at a DNS provider. **Needs admin (Windows).** | `use_dns("cloudflare")` |
| `current_dns()` | A list of the DNS server addresses this PC is using right now. Read-only — no admin. **Windows.** | `show current_dns()` |
| `on_new_device("task")` | Run a task whenever a brand-new gadget joins your network. **Keeps running in the background.** | `on_new_device("someone_arrived")` |
| `newdevice()` | The most recent new device that joined, as `"ip (name)"` — or `nothing` if none yet. | `show newdevice()` |

A few friendly notes:

- **`is_vpn`** and **`captive_portal`** both reach out to the internet to check, so they need you to be online. `is_vpn` says `yes` when your public IP looks like a proxy or a hosting/datacenter provider — strong hints you're not on a plain home line.
- **`whos_home`** and the new-device watcher read your ARP table and quietly skip the "everyone" addresses (broadcast and multicast), so you only ever see real, individual gadgets.
- **`portscan`** tidies the host for you: `portscan("https://router.lan/x")` becomes `router.lan`. With no range it checks a curated list of common ports; pass `[start, end]` to scan your own range (up to ~2000 ports at a time, between 1 and 65535).
- **`services`** scans those same common ports and labels each open one — so instead of a bare `443` you get `"Secure web (HTTPS)"`. Unknown open ports come back as `"Port 1234"`.

### `use_dns` — pick your DNS, system-wide

`use_dns` sets DNS for your **whole computer** (with `netsh`), so it needs **administrator rights**. On Windows, right-click your Sprout/terminal and choose **Run as administrator**, then try again. It understands these friendly names, plus any plain address:

| You write | DNS server it uses |
| --- | --- |
| `use_dns("cloudflare")` | `1.1.1.1` |
| `use_dns("google")` | `8.8.8.8` |
| `use_dns("quad9")` | `9.9.9.9` |
| `use_dns("family")` | `1.1.1.3` (filtered) |
| `use_dns("auto")` | back to your router's automatic DNS |
| `use_dns("1.2.3.4")` | any custom address you like |

> **Why this beats the browser's own DNS.** Setting DNS here is enforced at the **OS level**, so it covers what a browser's built-in *Secure DNS* (DNS-over-HTTPS) would otherwise sidestep. That's the exact trick that lets a clever browser dodge a [hosts-file block](networking-blocking.md) — so pair `use_dns` with blocking when you want a block that really sticks. After the change, Sprout flushes the DNS cache so it takes effect right away.

### `on_new_device` — a background watcher

`on_new_device("someone_arrived")` registers a task to run every time a new gadget joins. The watcher **starts when your program finishes** and then keeps Sprout running — checking the network every ~25 seconds — so it can fire forever. Press **Ctrl+C** to stop. Inside your task, call `newdevice()` to see who just arrived (as `"ip (name)"`). If a task hits a problem, Sprout prints a friendly note and keeps watching instead of crashing.

## Example: a quick connection check-up

```sprout
use "networking"

when is_vpn():
    show "Looks like you're on a VPN or proxy. 🛡️"
otherwise:
    show "This looks like a normal home connection."

when captive_portal():
    show "You need to sign in to this Wi-Fi first."

show "On the network right now:", whos_home()
show "Open ports on my router:", portscan("192.168.1.1")
show "Services on example.com:", services("example.com")
show "My DNS servers:", current_dns()
```

## Example: greet every new gadget

```sprout
use "networking"

task someone_arrived():
    show "👋 New device joined:", newdevice()

on_new_device("someone_arrived")
show "Watching the network — press Ctrl+C to stop."
```

This baselines whoever's already on the network, then announces only genuinely
new arrivals. Leave it running and connect your phone to see it fire.

## Caveats

- **`use_dns` needs admin (Windows).** It changes a system-wide setting with `netsh`; without admin it stops and tells you to run as administrator. `current_dns` is read-only and runs fine without admin.
- **Windows-only bits.** `use_dns` and `current_dns` are Windows features, and friendly device names (in `whos_home` and `newdevice`) come from a Windows reverse-DNS lookup — elsewhere you'll just see IP addresses.
- **`is_vpn` and `captive_portal` need internet.** They each ask a small web service to check; offline, they can't give a real answer.
- **`on_new_device` keeps running.** It holds your program open and polls forever until you press Ctrl+C.
- **Scan responsibly.** `portscan` and `services` only check ports on hosts *you* own or have permission to test.

## See also

- [Libraries](../libraries.md) — how `use` works and what else ships in the box
- [Blocking websites](networking-blocking.md) — pair with `use_dns` for blocks that stick
- [Your local network](networking-devices.md) — list, ping, and wake the gadgets on your Wi-Fi
