# networking

Friendly network tools for Sprout. Add it with `use "networking"`.

```sprout
use "networking"
show "This computer:", hostname(), "  IP:", localip()
when online():
    show "ping google:", ping("google.com"), "ms"
```

The library is split into topic files so each part is easy to read:

| File | What's inside | Docs |
| --- | --- | --- |
| [`info.ts`](info.ts) | hostname, localip, myip, online, status, ping, download + diagnostics (speedtest, whereis, wifi, isopen, hops, whois) | [Info & diagnostics](../../wiki/libraries/networking-info.md) |
| [`blocking.ts`](blocking.ts) | block, unblock, blocked, unblock_all, block_category, block_until | [Blocking websites](../../wiki/libraries/networking-blocking.md) |
| [`devices.ts`](devices.ts) | devices, router, devicename, find, isup, wake | [Your local network](../../wiki/libraries/networking-devices.md) |
| [`monitoring.ts`](monitoring.ts) | monitor, watchinternet, isdown, avgping, healthcheck, logstatus, uptime | [Uptime monitoring](../../wiki/libraries/networking-monitoring.md) |
| [`sharing.ts`](sharing.ts) | share, serve, sharetext, sendphone, qr | [Sharing to your phone](../../wiki/libraries/networking-sharing.md) |

`index.ts` just merges the topic modules together. Full reference:
**[wiki/libraries](../../wiki/libraries/README.md)**.

> Editing the hosts file (`block` / `unblock`) needs **administrator** rights.
> Several tools are **Windows-focused**.
