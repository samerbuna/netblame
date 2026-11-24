# Net Monitor

A local page that shows whether this machine can reach the internet, and why not when it can't. It also watches the machine itself, since a full disk or a maxed-out CPU can feel like a bad connection.

```zsh
npm start              # or: node src/cli.ts
```

It opens http://localhost:4321. Needs Node 22.18 or later in the 22 line, or 23.6 or newer, which run the `.ts` files directly. There are no dependencies. Works on macOS and Linux.

## What it checks

Every 3 seconds it pings the router and `1.1.1.1` and looks up a random name under `example.com`. The random name means no DNS cache can answer, so a broken upstream DNS server shows up. Every 30 seconds it also fetches `http://cp.cloudflare.com/generate_204`, which returns an empty 204. It runs that fetch at once whenever a ping or DNS check fails, so a single dropped ping doesn't count as an outage, and a network that blocks ping still shows as online.

The status is:

- **Online**: the internet is reachable and DNS and the web check pass.
- **Degraded**: reachable, but DNS fails, web requests fail, or something answers the web check with a page instead of 204 (a captive portal). Also shown for the first failed round before an outage is confirmed, for 20 seconds after the machine wakes from sleep, and whenever the machine health check below has a warning.
- **Offline**: two rounds in a row with no ping reply and no web response. The cause says whether the router answered, which separates a Wi-Fi problem from a modem or ISP problem.

All of this comes to roughly 5 to 10 MB a day.

## Machine health

Every 10 seconds it also records CPU use, memory in use, swap, free disk space, and bytes per second in and out on the interface the router is reached through. Battery level and thermal throttling are read once a minute. On macOS these come from `sysctl`, `vm_stat`, `netstat` and `pmset`; on Linux from `/proc` and `/sys`. Nothing needs sudo.

The status turns Degraded, with the reason shown, when:

- free disk space on `/` (or `DISK_PATH`) is under 5 GB, or under 10% while also under 50 GB, so a big disk with hundreds of GB free doesn't count as full;
- memory in use averages over 90% for a minute (on macOS this is the figure memory pressure is based on, not `free` pages, which are near zero on a healthy Mac);
- the machine averages over 1 MB/s of swap-outs for a minute;
- CPU averages over 90% for a minute;
- the battery is under 10% and not on power;
- macOS reports the CPU slowed down for heat (not checked on Linux).

The averages cover a minute, or four samples if `MACHINE_MS` is set longer than 15 seconds.

The page also lists the processes using the most CPU and memory. That list is collected only while the page is open and isn't saved.

## Data

History lives in `~/Library/Application Support/is-it-me` on macOS and `~/.local/state/is-it-me` on Linux (or `$XDG_STATE_HOME/is-it-me`). Each round is appended as one JSON line to `YYYY-MM-DD.jsonl` there, and each machine health sample to `YYYY-MM-DD.machine.jsonl`. Together they take about 2.5 MB a day. Files older than 7 days are deleted. The page loads the last 24 hours when it connects.

The server only listens on 127.0.0.1 and refuses requests whose Host header isn't `localhost` or `127.0.0.1`.

## Settings

Set these as environment variables, for example `PORT=4322 npm start`.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4321` | |
| `TICK_MS` | `3000` | time between check rounds |
| `PING_HOST` | `1.1.1.1` | internet ping target |
| `HTTP_URL` | `http://cp.cloudflare.com/generate_204` | must return 204 |
| `DNS_ZONE` | `example.com` | random names are looked up under this |
| `KEEP_DAYS` | `7` | days of history files to keep |
| `MACHINE_MS` | `10000` | time between machine health samples |
| `DISK_PATH` | `/` | free space is watched on the volume holding this path |
| `DATA_DIR` | see Data | where history files go |

It only monitors while it's running. Gaps when it was stopped or the machine slept show as breaks in the chart and don't count as outages.
