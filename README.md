# Is it me?

A local page that tells you whether a bad connection is your Wi-Fi, your router, your ISP, DNS, or this machine. It checks every few seconds, keeps a week of history, notifies you when something goes wrong, and gives you an outage report to send your ISP.

- `npx is-it-me` starts monitoring and opens the page.
- `npx is-it-me install` keeps it running: it starts now and at every login.
- `npx is-it-me report` prints an outage report for the last 7 days.

Needs Node 22 or newer, on macOS or Linux. It has no dependencies and needs no sudo. Nothing is sent anywhere except the checks themselves (see Privacy).

The page is at http://localhost:4321. Running `npx is-it-me` again while it's already running just opens the page.

## What the status means

- **Online**: the internet is reachable and DNS and the web check pass.
- **Degraded**: reachable, but something is wrong, and the reason says what:
  - DNS isn't answering, or web requests fail;
  - something answers the web check with a page instead of 204 (a captive portal);
  - pings are getting lost, jumping around, or climbing while the connection is busy;
  - this machine has a problem (disk, memory, CPU, Wi-Fi signal, battery, heat).

  It's also shown for the first failed round before an outage is confirmed, and for 20 seconds after waking from sleep.
- **Offline**: two rounds in a row with no ping reply and no web response. The reason says whether the router answered, which separates a Wi-Fi problem from a modem or ISP problem.

## What it checks

Every 3 seconds it pings the router and `1.1.1.1` and looks up a random name under `example.com`. The random name means no DNS cache can answer, so a broken upstream DNS server shows up. Every 30 seconds it also fetches `http://cp.cloudflare.com/generate_204`, which returns an empty 204. It runs that fetch at once whenever a ping or DNS check fails, so a single dropped ping doesn't count as an outage, and a network that blocks ping still shows as online.

On a working connection it also watches the quality, over the last minute:

- **Lost pings**: 3 or more lost, and at least 10%, on rounds where the web check passed.
- **Jitter**: consecutive pings differ by more than 30 ms on average. Calls stutter on this more than on high ping.
- **Slow under load** (bufferbloat): while 250 KB/s or more is moving, ping is 100 ms or more above its normal level (the 10th percentile of the last 30 minutes). This is a router letting its queue fill up. It breaks video calls while speed tests look fine.

It also records what changed and when: switching networks, a VPN coming up or going down, joining a phone hotspot (which uses mobile data), and waking from sleep. These show as dashed lines on the chart and in a list.

## Machine health

Every 10 seconds it records:
- CPU use and memory in use;
- swap;
- free disk space;
- bytes per second in and out on the interface the router is reached through;
- the Wi-Fi signal, while the router is reached over Wi-Fi.

Battery level and thermal throttling are read once a minute. On macOS these come from `sysctl`, `vm_stat`, `netstat`, `pmset` and CoreWLAN (through `osascript`); on Linux from `/proc` and `/sys`.

The status turns Degraded, with the reason, when:

- free disk space on `/` (or `DISK_PATH`) is under 5 GB, or under 10% while also under 50 GB, so a big disk with hundreds of GB free doesn't count as full;
- on macOS, memory pressure is at warning or critical for at least half of the last minute, the same level Activity Monitor colors its memory graph by; on Linux, memory in use averages over 90% for a minute;
- the machine averages over 1 MB/s of swap-outs for a minute;
- CPU averages over 90% for a minute;
- the Wi-Fi signal averages under -75 dBm for a minute;
- the battery is under 10% and not on power;
- macOS reports the CPU slowed down for heat (not checked on Linux).

The averages cover a minute, or four samples if `MACHINE_MS` is set longer than 15 seconds.

While the page is open, it also lists the processes using the most CPU and memory, and on macOS the most network traffic. These lists aren't saved.

## Notifications

It posts a desktop notification when:
- the connection goes Offline, and again when it's back, with how long it was out;
- the connection stays Degraded for two minutes, and when that ends;
- a machine warning appears. The same warning repeats at most every 30 minutes.

On macOS the notifications come from `osascript`, so the first one may ask for permission. On Linux they use `notify-send` when it's installed. Set `NOTIFY=0` to turn them off.

## Start at login

```zsh
npx is-it-me install
```

This sets it up as a launchd agent on macOS, or a systemd user service on Linux, starts it now, and restarts it if it crashes. It copies the app into its data folder first, because npx runs packages from a cache that can be cleared, and it runs that copy with the Node that ran `install`. Settings set at install time (`PORT=4322 npx is-it-me install`) are kept. Run `install` again to upgrade or change settings. `npx is-it-me uninstall` removes it and keeps the history.

## Outage report

`npx is-it-me report` prints the last 7 days, or `report --days 3` for fewer:
- the period;
- how much of it was monitored;
- uptime;
- each outage with its start, duration and likely cause;
- median ping and loss.

The page's "Copy report for your ISP" button copies the same text. It reads the history files, so it works with the monitor stopped.

## Speed test (macOS)

The Speed test card runs Apple's `networkQuality`. It shows download and upload speed, and responsiveness: how far ping rises while the connection is busy. A run takes about 20 seconds and moves a few hundred MB, so it only runs when you press the button, and the page asks first when you're on a phone hotspot.

## Data

History lives in `~/Library/Application Support/is-it-me` on macOS and `~/.local/state/is-it-me` on Linux (or `$XDG_STATE_HOME/is-it-me`). There is one file per day for each kind:
- `YYYY-MM-DD.jsonl`: network checks;
- `YYYY-MM-DD.machine.jsonl`: machine health;
- `YYYY-MM-DD.events.jsonl`: changes.

Together they take about 3 MB a day. Files older than 7 days are deleted. The page loads the last 24 hours when it connects.

It only monitors while it's running. Gaps when it was stopped or the machine slept show as breaks in the chart and don't count as outages.

## Settings

Set these as environment variables, for example `PORT=4322 npx is-it-me`.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4321` | |
| `TICK_MS` | `3000` | time between check rounds |
| `PING_HOST` | `1.1.1.1` | internet ping target |
| `HTTP_URL` | `http://cp.cloudflare.com/generate_204` | must return 204; keep it http to detect captive portals |
| `DNS_ZONE` | `example.com` | random names are looked up under this |
| `KEEP_DAYS` | `7` | days of history files to keep |
| `MACHINE_MS` | `10000` | time between machine health samples |
| `DISK_PATH` | `/` | free space is watched on the volume holding this path |
| `DATA_DIR` | see Data | where history files go |
| `NOTIFY` | `1` | `0` turns notifications off |

## Privacy and security

The checks contact your router, `1.1.1.1` (ping), your DNS servers (for random names under `example.com`) and `cp.cloudflare.com` (the web check), which adds up to roughly 5 to 10 MB a day. A speed test contacts Apple's test servers. Nothing else leaves the machine, and there's no account or telemetry.

The server listens on 127.0.0.1 only and refuses requests whose Host header isn't `localhost` or `127.0.0.1`, so other web pages can't reach it through DNS rebinding. Actions that cost something, like starting a speed test, also need the page's own Origin.

## Development

- `npm install` installs TypeScript, which is only used for type checking.
- `npm start` runs `src/` directly. Running from source needs Node 22.18+ or 23.6+.
- `npm test` runs the tests with `node --test`.
- `npm run check` type-checks with `tsc`.
- `npm run build` writes `dist/`, the JavaScript the npm package runs.

`src/` is the TypeScript server: checks, rules, history, notifications, the login service, the web server. `public/` is the page. The status logic in `public/lib` is shared by the page, the report and the tests. The build uses Node's own type stripper, because Node won't strip types from `.ts` files inside `node_modules`.

Linux support is written against the documented formats of `/proc`, `/sys` and `ip`, but hasn't been tested on a Linux machine yet.
