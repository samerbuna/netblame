import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePing, parseRoute, ROUTE_RE, isTunnel, isPhoneHotspot } from '../src/checks.ts';
import { describeNetwork } from '../src/monitor.ts';

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

test('isTunnel: VPN interfaces, not physical ones', () => {
  for (const i of ['utun3', 'tun0', 'wg0', 'ppp0', 'ipsec0', 'tailscale0', 'zt7nnig26']) assert.ok(isTunnel(i), i);
  for (const i of ['en0', 'en1', 'wlan0', 'eth0', 'bridge100', null]) assert.ok(!isTunnel(i), String(i));
});

test('isPhoneHotspot: iPhone and older Android router addresses', () => {
  assert.ok(isPhoneHotspot('172.20.10.1'));
  assert.ok(isPhoneHotspot('192.168.43.1'));
  assert.ok(!isPhoneHotspot('192.168.1.1'));
  assert.ok(!isPhoneHotspot(null));
});

test('describeNetwork: interface, router, hotspot and VPN', () => {
  assert.equal(describeNetwork(null, null, null), 'no network');
  assert.equal(describeNetwork('192.168.1.1', 'en0', null), 'en0, router 192.168.1.1');
  assert.equal(describeNetwork('172.20.10.1', 'en1', 'utun3'), 'en1, router 172.20.10.1 (phone hotspot, uses mobile data), VPN on (utun3)');
});
