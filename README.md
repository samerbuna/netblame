# Net Monitor

A local page that shows whether this machine can reach the internet, and why not when it can't.

```zsh
node monitor.ts        # or: npm start
open http://localhost:4321
```

Needs Node 22.18 or newer, which runs the `.ts` file directly. There are no dependencies. Works on macOS and Linux.

## What it checks

Every 3 seconds it pings the router and `1.1.1.1` and looks up a random name under `example.com`. The random name means no DNS cache can answer, so a broken upstream DNS server shows up. Every 30 seconds it also fetches `http://cp.cloudflare.com/generate_204`, which returns an empty 204. It runs that fetch at once whenever a ping or DNS check fails, so a single dropped ping doesn't count as an outage, and a network that blocks ping still shows as online.

The status is:

- **Online**: the internet is reachable and DNS and the web check pass.
- **Degraded**: reachable, but DNS fails, web requests fail, or something answers the web check with a page instead of 204 (a captive portal). Also shown for the first failed round before an outage is confirmed, and for 20 seconds after the machine wakes from sleep.
- **Offline**: two rounds in a row with no ping reply and no web response. The cause says whether the router answered, which separates a Wi-Fi problem from a modem or ISP problem.

All of this comes to roughly 5 to 10 MB a day.

## Data

Each round is appended as one JSON line to `data/YYYY-MM-DD.jsonl`. Files older than 7 days are deleted. The page loads the last 24 hours when it connects.

The server only listens on 127.0.0.1 and refuses requests whose Host header isn't `localhost` or `127.0.0.1`.

## Settings

Set these as environment variables, for example `PORT=4322 node monitor.ts`.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4321` | |
| `TICK_MS` | `3000` | time between check rounds |
| `PING_HOST` | `1.1.1.1` | internet ping target |
| `HTTP_URL` | `http://cp.cloudflare.com/generate_204` | must return 204 |
| `DNS_ZONE` | `example.com` | random names are looked up under this |
| `KEEP_DAYS` | `7` | days of history files to keep |

It only monitors while `monitor.ts` is running. Gaps when it was stopped or the machine slept show as breaks in the chart and don't count as outages.
