# Library reference — one page per topic

Detailed docs for each library, split so every topic is easy to read. Start at
the main **[Libraries](../libraries.md)** page for the overview, or jump straight
in below.

## networking — `use "networking"`

| Page | Functions |
| --- | --- |
| [Info & diagnostics](networking-info.md) | `hostname` `localip` `macaddress` `myip` `online` `status` `ping` `download` `isopen` `hops` `wifi` `wifisignal` `whereis` `speedtest` `whois` |
| [Blocking websites](networking-blocking.md) | `block` `unblock` `isblocked` `blocked` `unblock_all` `block_category` `unblock_category` `block_until` |
| [Your local network](networking-devices.md) | `devices` `router` `devicename` `find` `isup` `wake` |
| [Uptime monitoring](networking-monitoring.md) | `monitor` `watchinternet` `isdown` `avgping` `healthcheck` `logstatus` `uptime` |
| [Sharing to your phone](networking-sharing.md) | `share` `serve` `sharetext` `sendphone` `qr` |
| [Web & data](networking-web.md) | `weather` `mac_vendor` `ssl_expiry` `cert` `dns` `headers` `shorten` `expand` `filesize` |
| [Security & presence](networking-security.md) | `is_vpn` `captive_portal` `whos_home` `portscan` `services` `use_dns` `current_dns` `on_new_device` `newdevice` |

## automations — `use "automations"`

| Page | Functions |
| --- | --- |
| [Scheduling & clock](automations-scheduling.md) | `wait` `now` `today` `weekday` `every` `after` `at` `watch` `stop` `countdown` `alarm` `ring` `snooze` `on_days` `on_first` `sunrise` `sunset` `at_sunrise` `at_sunset` `catch_up` |
| [Run on PC startup](automations-startup.md) | `run_on_startup` `runs_on_startup` `start_with_pc` `stop_with_pc` `starts_with_pc` |
| [Launch & control apps](automations-apps.md) | `launch` `running` `closeapp` |
| [System control](automations-system.md) | `volume` `mute` `muted` `shutdown` `restart` `sleep` `lock` `darkmode` `wallpaper` `clipboard` `brightness` `keepawake` `say` |
| [Keyboard / mouse / screenshot](automations-macros.md) | `type` `press` `screenshot` `copy_text` `clipboard` `movemouse` `click` `mousepos` `typeto` |
| [Event triggers](automations-triggers.md) | `when_idle` `when_back` `on_usb` `on_usb_removed` `on_open` `on_close` `on_wifi` `on_offline` `on_low_battery` `on_charging` `on_hotkey` |
| [One-word routines](automations-routines.md) | `workmode` `pomodoro` `morning` `bedtime` `routine` `run_routine` `say` |
| [System stats & pop-ups](automations-stats.md) | `cpu` `ram` `disk` `battery` `charging` `pc_uptime` `processes` `idle_time` `notify` `popup` `confirm` `ask_box` `watch_cpu` `watch_ram` |
| [Files & folders](automations-files.md) | `read_file` `write_file` `append_file` `log` `files` `newest` `oldest` `biggest` `foldersize` `count` `freespace` `open_folder` `backup` `zip` `unzip` `snapshot` `restore` `versions` `sort_downloads` |
| [Sound, mic & windows](automations-sound.md) | `beep` `play_sound` `mute_mic` `mic_muted` `dnd` `show_desktop` `minimize_all` `focus_window` |
| [Reminders & life triggers](automations-reminders.md) | `remind` `timer` `stopwatch` `elapsed` `on_lock` `on_unlock` `on_clipboard` `on_low_disk` |

> The system, macro, trigger, and routine features are **Windows-focused**.
> Anything that edits the hosts file (`block`) needs **administrator** rights.

## See also

- [Libraries overview](../libraries.md) · [Cheat sheet](../cheatsheet.md) · [Built-in functions](../builtins.md)
