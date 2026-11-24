import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMacWifi, parseProcWireless } from '../src/wifi.ts';

test('parseMacWifi: associated, not associated, and no channel', () => {
  assert.deepEqual(parseMacWifi('en1,-53,-92,867,149\n'), { iface: 'en1', rssi: -53, noise: -92, rate: 867, ch: 149 });
  assert.equal(parseMacWifi('en0,0,0,0,\n'), null);
  assert.deepEqual(parseMacWifi('en0,-70,-95,144,'), { iface: 'en0', rssi: -70, noise: -95, rate: 144, ch: null });
  assert.equal(parseMacWifi(''), null);
});

const PROC = `Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE
 face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22
 wlan0: 0000   54.  -56.  -256        0      0      0      0      0        0
 wlp2s0: 0000   40.  200.  -95        0      0      0      0      0        0
`;

test('parseProcWireless: picks the interface, handles unsigned levels and unknown noise', () => {
  assert.deepEqual(parseProcWireless(PROC, 'wlan0'), { iface: 'wlan0', rssi: -56, noise: null, rate: null, ch: null });
  assert.deepEqual(parseProcWireless(PROC, 'wlp2s0'), { iface: 'wlp2s0', rssi: -56, noise: -95, rate: null, ch: null });
  assert.equal(parseProcWireless(PROC, 'eth0'), null);
  assert.equal(parseProcWireless('', 'wlan0'), null);
});
