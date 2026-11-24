import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePing, parseRoute, ROUTE_RE } from '../src/checks.ts';

test('parsePing: macOS and Linux output, and no reply', () => {
  assert.equal(parsePing('64 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=18.432 ms'), 18.4);
  assert.equal(parsePing('64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=9.87 ms'), 9.9);
  assert.equal(parsePing('64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time<1 ms'), 1);
  assert.equal(parsePing('1 packets transmitted, 0 packets received, 100.0% packet loss'), null);
});

test('parseRoute: Linux ip route', () => {
  assert.deepEqual(parseRoute('default via 192.168.1.1 dev wlan0 proto dhcp metric 600\n', ROUTE_RE.linux), { gateway: '192.168.1.1', iface: 'wlan0' });
  assert.deepEqual(parseRoute('default via 10.0.0.1\n', ROUTE_RE.linux), { gateway: '10.0.0.1', iface: null });
  assert.equal(parseRoute('', ROUTE_RE.linux), null);
});

test('parseRoute: macOS route get and netstat', () => {
  const route = '   route to: default\ndestination: default\n       mask: default\n    gateway: 172.20.10.1\n  interface: en1\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>\n';
  assert.deepEqual(parseRoute(route, ROUTE_RE.macRoute), { gateway: '172.20.10.1', iface: 'en1' });
  const netstat = 'Routing tables\n\nInternet:\nDestination        Gateway            Flags        Netif Expire\ndefault            192.168.1.1        UGScg          en0       \n';
  assert.deepEqual(parseRoute(netstat, ROUTE_RE.macNetstat), { gateway: '192.168.1.1', iface: 'en0' });
});
