# How netblame works

## The three statuses

- **Online**: the internet answers, and DNS and the web check pass.
- **Degraded**: the internet answers, but something is wrong, and the reason says what. DNS may not be answering, the web check may be failing or caught by a captive portal, the connection may be bad for calls, or your computer may have a problem. Degraded also shows for the first failed round before an outage is confirmed, and for 20 seconds after waking from sleep, while Wi-Fi reconnects.
- **Offline**: two rounds in a row with no ping reply and no web response. The reason says how far the connection gets. "No network" means Wi-Fi is off or not joined. "Router not responding" points at the Wi-Fi or the router. "Router OK, nothing beyond it" points at the modem or your provider.

## Network checks

Every 3 seconds, netblame pings the router and `1.1.1.1` and looks up a random name under `example.com`. No DNS cache has seen the random name, so the lookup has to reach a DNS server, and a broken server shows up.

Every 30 seconds it also fetches `http://cp.cloudflare.com/generate_204`, which answers with an empty 204 response. A captive portal answers with its own page instead. The fetch also runs right away whenever a ping or the lookup fails. That way a single lost ping doesn't count as an outage, and a network that blocks ping still shows as online.

## Connection quality

When the connection works, three more rules look at the last minute. They start once samples cover at least 45 seconds of it, so they don't fire right after starting or waking.

- **Lost pings**: 3 or more pings lost, and at least 10% of them. A ping only counts as lost when the web check passed in the same round. Pings lost during an outage count toward the outage instead. A network that blocks ping has no replies at all, so it isn't judged.
- **Jitter**: pings to the internet change by more than 30 ms on average from one to the next, over at least 10 pairs.
- **Bufferbloat**: while 250 KB/s or more is moving, the median ping of the last 30 seconds is 100 ms or more above normal. Normal is the 10th percentile of the last 30 minutes. This happens when the router holds packets in a long queue behind a big upload or download.

## Changes

netblame records these changes, draws them as dashed lines on the chart, and lists them on the page:

- the monitor starting, with the network it found;
- the router or the network interface changing;
- a VPN connecting or disconnecting;
- waking from sleep;
- a speed test's result.

It counts a VPN as connected when the route to `1.1.1.1` goes through an interface named `utun`, `tun`, `tap`, `wg`, `ppp`, `ipsec`, `tailscale` or `zt`. It marks a router at `172.20.10.1` or `192.168.43.1` as a phone hotspot, which uses mobile data. iPhones use the first address when they share their connection, and older Android phones use the second.

## Your computer

Every 10 seconds netblame records CPU use, memory in use, swap, free disk space, and the bytes per second in and out on the interface the router is reached through. While the router is reached over Wi-Fi, it also records the signal strength. It reads the battery level and thermal throttling once a minute. On macOS the numbers come from `sysctl`, `vm_stat`, `netstat`, `pmset` and CoreWLAN, through `osascript`. On Linux they come from `/proc` and `/sys`.

The status turns Degraded, with the reason, when:

- free space on `/` (or `DISK_PATH`) is under 5 GB, or under 10% while also under 50 GB, so a big disk with hundreds of GB free doesn't count as full;
- on macOS, memory pressure is at warning or critical for at least half of the last minute, which is the level Activity Monitor colors its memory graph by; on Linux, memory in use averages over 90% for a minute;
- swap-outs average over 1 MB/s for a minute;
- CPU use averages over 90% for a minute;
- the Wi-Fi signal averages under -75 dBm for a minute;
- the battery is under 10% and not plugged in;
- macOS reports that the CPU slowed down for heat. netblame doesn't check this on Linux.

When `MACHINE_MS` is longer than 15 seconds, the averages cover four samples instead of a minute.

While the page is open, it also lists the apps using the most CPU and memory, and on macOS the most network. These lists aren't saved. Linux needs root to see network use per app, so that list only shows on macOS.

## Notifications

- **Offline**: right away, since Offline already takes two failed rounds. When the connection is back, a second notification says how long it was out.
- **Degraded**: once it has lasted two minutes in a row, and again when it ends. "Reconnecting after sleep" and the first failed round don't count.
- **Your computer**: when a warning appears. The same warning repeats at most every 30 minutes.

Nothing is sent in the first minute after starting, while the first checks come in. An outage that's already going then gets its notification when the minute is up.

On macOS the notifications come from `osascript`, so the first one may ask for permission. On Linux they use `notify-send` when it's installed.

## History

netblame writes one file a day for each kind of record, as JSON lines:

- `YYYY-MM-DD.jsonl`: the network checks;
- `YYYY-MM-DD.machine.jsonl`: your computer;
- `YYYY-MM-DD.events.jsonl`: the changes.

Together they take about 3 MB a day. netblame deletes files older than `KEEP_DAYS` days. The page loads the last 24 hours when it opens.

The files live in `~/Library/Application Support/netblame` on macOS. On Linux they live in `$XDG_STATE_HOME/netblame`, or in `~/.local/state/netblame` when that isn't set.

netblame only watches while it's running. Time when it was stopped or the computer was asleep shows as a gap in the charts and doesn't count as an outage.

## The login service

`install` first copies the app into `app/` in the data folder, because npx runs packages from a cache that can be cleared. The service runs that copy with the Node binary that ran `install`, so if you remove that Node version, run `install` again. The service's output goes to `netblame.log` in the data folder. `install` writes any settings you run it with, like `PORT=4322 npx netblame install`, into the service.

## Security

The server listens on 127.0.0.1 only. It refuses requests whose Host header isn't `localhost` or `127.0.0.1`. That blocks DNS rebinding, where a website points its own name at 127.0.0.1 so the browser lets the site talk to your computer. Starting a speed test also needs the request to come from netblame's own page, so another website can't start tests and use up your data.
