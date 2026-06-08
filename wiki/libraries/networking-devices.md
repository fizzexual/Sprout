# networking: your local network 🌐

This little library lets you peek at the gadgets sharing your Wi-Fi — phones,
laptops, the TV, the printer — and poke at them. It reads your computer's own
**ARP table** (the list of "who have I recently talked to" addresses the OS
keeps), asks Windows for your router, looks up friendly names, pings to see who's
awake, and can even send a **Wake-on-LAN** "magic packet" to switch a sleeping PC
back on. No extra installs — it just uses tools your computer already has.

Add it to your program with:

```sprout
use "networking"
```

After that, all the functions below work just like Sprout's built-in ones.

> **Mostly Windows.** Names, your router, and waking PCs lean on Windows
> commands. `devices()` and `isup()` (with a plain IP) work elsewhere too, but
> this library is happiest on Windows.

## Functions

| Function | What it does | Example |
| --- | --- | --- |
| `devices()` | a list of the gadgets on your network, each as a `"192.168.1.20 (aa-bb-cc-dd-ee-ff)"` string | `for each d in devices():` |
| `router()` | the address of your router (the box that connects you to the internet), or `nothing` if it can't be found | `show router()` |
| `devicename("ip")` | the friendly name of the gadget at that address (or the address itself if there's no name) | `devicename("192.168.1.20")` |
| `isup("target")` | `yes`/`no`: is that device awake and reachable right now? `target` can be an IP **or** a device name | `isup("192.168.1.42")` |
| `find("name")` | the IP of the named gadget on your network, or `nothing` if there's no match | `find("my-phone")` |
| `wake("mac")` | nudge a sleeping computer awake with a Wake-on-LAN magic packet (gives back `nothing`) | `wake("aa-bb-cc-dd-ee-ff")` |

A few friendly notes:

- **`devices()`** quietly hides the "everyone" addresses — broadcast and
  multicast entries — because those aren't real, individual gadgets you'd want
  to list. You get one line per real device.
- **`devicename`**, **`isup`** (by name), and **`find`** look up names with a
  Windows reverse-DNS lookup. On other systems (or when a device has no name on
  record) you'll just get the IP back.
- **`isup`** is clever: hand it a plain IP and it pings that directly; hand it a
  name and it finds the matching gadget first, then pings it. Matching is
  loose — `isup("phone")` matches any device whose name *contains* "phone".
- **`find`** matches names the same loose way, and gives back the **first**
  device that matches.
- **`wake`** accepts a MAC written with dashes, colons, or run together
  (`aa-bb-cc-dd-ee-ff`, `aa:bb:cc:dd:ee:ff`, or `aabbccddeeff`). The packet is
  broadcast to your whole network. The target PC must have **Wake-on-LAN turned
  on in its own settings** for this to do anything — Sprout sends the nudge, but
  it's up to the PC to listen.

## Example: who's on my Wi-Fi?

```sprout
use "networking"

show "Things on my network:"
for each d in devices():
    show "  •", d

show "My router is", router()
```

This prints each device as `IP (MAC)`, then your router's address. Run it twice
a few minutes apart and you'll often see the list change as gadgets come and go.

## Example: is the TV awake, and wake a PC

```sprout
use "networking"

~ check a device by its address
when isup("192.168.1.42"):
    show "The TV is awake 📺"
otherwise:
    show "The TV is asleep 😴"

~ or check by name — find where the phone landed today
make phone = find("my-phone")
when phone == nothing:
    show "Can't see my phone right now."
otherwise:
    show "My phone is at", phone

~ nudge a sleeping computer awake (it needs Wake-on-LAN enabled)
wake("aa-bb-cc-dd-ee-ff")
show "Sent the wake-up nudge!"
```

> **Tip:** run `devices()` first to see the MAC addresses you can pass to
> `wake(...)` — they're the part in parentheses, like `(aa-bb-cc-dd-ee-ff)`.

## See also

- [Libraries](../libraries.md) — every library, and how to manage them with `sprout modules`
- [Built-in Functions](../builtins.md) — the functions that come with Sprout itself
