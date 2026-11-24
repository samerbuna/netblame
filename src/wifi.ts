// Wi-Fi link quality: signal strength, noise, transmit rate and channel. No sudo.
// macOS: CoreWLAN through osascript's JavaScript bridge, so nothing needs compiling.
// (The old airport tool is gone since macOS 14.4.) Linux: /proc/net/wireless.

import { run, readText } from './exec.ts';

export interface Wifi {
  iface: string;
  rssi: number;         // signal, dBm
  noise: number | null; // dBm
  rate: number | null;  // transmit rate, Mbps
  ch: number | null;    // channel
}

// Prints "en1,-53,-92,867,149". The channel is missing when not associated.
const JXA = [
  'ObjC.import("CoreWLAN");',
  'var i = $.CWWiFiClient.sharedWiFiClient.interface;',
  'var ch = ""; try { ch = i.wlanChannel.channelNumber; } catch (e) {}',
  '[i.interfaceName.js, i.rssiValue, i.noiseMeasurement, i.transmitRate, ch].join(",")',
].join(' ');

const num = (s: string | undefined) => (s === undefined || s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));

export function parseMacWifi(out: string): Wifi | null {
  const [iface, rssi, noise, rate, ch] = out.trim().split(',');
  const signal = num(rssi);
  // An RSSI of 0 means not associated with a network.
  if (!iface || signal === null || signal === 0) return null;
  return { iface, rssi: signal, noise: num(noise) || null, rate: num(rate) || null, ch: num(ch) || null };
}

// /proc/net/wireless: two header lines, then "wlan0: 0000   54.  -56.  -256 ...".
// Some drivers print the level unsigned (200 for -56); a noise of -256 or 0 means unknown.
export function parseProcWireless(text: string, iface: string): Wifi | null {
  for (const line of text.split('\n').slice(2)) {
    const m = /^\s*([^:\s]+):\s+\S+\s+(-?[\d.]+)\.?\s+(-?[\d.]+)\.?\s+(-?[\d.]+)\.?/.exec(line);
    if (!m || m[1] !== iface) continue;
    let level = Number(m[3]);
    if (level > 0 && level <= 255) level -= 256;
    if (!Number.isFinite(level) || level === 0 || level <= -256) return null;
    const noise = Number(m[4]);
    return { iface, rssi: level, noise: noise < 0 && noise > -256 ? noise : null, rate: null, ch: null };
  }
  return null;
}

// The Wi-Fi link, only when iface (the one the router is reached on) is the Wi-Fi interface.
export async function readWifi(iface: string | null): Promise<Wifi | null> {
  if (!iface) return null;
  if (process.platform === 'darwin') {
    const out = await run('osascript', ['-l', 'JavaScript', '-e', JXA]);
    const w = out ? parseMacWifi(out) : null;
    return w && w.iface === iface ? w : null;
  }
  const text = await readText('/proc/net/wireless');
  return text ? parseProcWireless(text, iface) : null;
}
