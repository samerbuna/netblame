import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNetworkQuality, describeSpeed } from '../src/speedtest.ts';

test('parseNetworkQuality: throughput, responsiveness, idle round-trip', () => {
  const json = JSON.stringify({
    base_rtt: 28.08, dl_flows: 12, dl_throughput: 220837152, interface_name: 'en1',
    responsiveness: 1256, ul_flows: 12, ul_throughput: 22540544, start_date: '11/24/26, 10:40:00', end_date: '11/24/26, 10:40:21',
  });
  const r = parseNetworkQuality(json);
  assert.deepEqual(r, { down: 220837152, up: 22540544, rpm: 1256, baseRtt: 28.08, iface: 'en1' });
  assert.equal(describeSpeed(r), 'Speed test: 221 Mbps down, 23 Mbps up, responsiveness 1256 RPM (about 48 ms under load)');
});

test('parseNetworkQuality: newer key names and failures', () => {
  assert.equal(parseNetworkQuality(JSON.stringify({ dl_throughput: 1e6, dl_responsiveness: 300 })).rpm, 300);
  const failed = parseNetworkQuality(JSON.stringify({ error_code: -1009, error_domain: 'NSURLErrorDomain' }));
  assert.equal(failed.error, 'networkQuality failed (NSURLErrorDomain)');
  assert.equal(describeSpeed(failed), 'Speed test failed: networkQuality failed (NSURLErrorDomain)');
  assert.equal(parseNetworkQuality('not json').error, 'networkQuality printed something unexpected');
});
