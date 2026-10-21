import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPublicAddress } from '../public-address.js';

const REFUSED = [
  // IPv4: this network, private, shared, loopback, link-local (cloud metadata), protocol,
  // documentation, benchmarking, multicast, reserved and broadcast
  '0.0.0.0',
  '0.1.2.3',
  '10.0.0.1',
  '10.255.255.255',
  '100.64.0.1',
  '100.127.255.255',
  '127.0.0.1',
  '127.255.255.254',
  '169.254.169.254',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.1',
  '192.0.2.7',
  '192.88.99.1',
  '192.168.1.1',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.9',
  '203.0.113.9',
  '224.0.0.1',
  '239.255.255.255',
  '240.0.0.1',
  '255.255.255.255',
  // IPv6: unspecified, loopback, unique local, link local, site local, multicast, documentation
  '::',
  '::1',
  'fc00::1',
  'fd12:3456::1',
  'fe80::1',
  'fec0::1',
  'ff02::1',
  '2001:db8::1',
  '3fff::1',
  // IPv4 inside IPv6: mapped (both spellings), compatible, NAT64, 6to4, Teredo
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:10.1.2.3',
  '::ffff:a9fe:a9fe',
  '::127.0.0.1',
  '::7f00:1',
  '64:ff9b::7f00:1',
  '64:ff9b::808:808',
  '64:ff9b:1::1',
  '2002:7f00:1::1',
  '2002:808:808::1',
  '2001::1',
  // Not an address at all, or one with a zone
  '',
  'localhost',
  'example.com',
  '127.1',
  '2130706433',
  '0x7f.0.0.1',
  '010.0.0.1',
  '1.2.3',
  '1.2.3.4.5',
  '256.1.1.1',
  'fe80::1%eth0',
  '::g',
];

const ALLOWED = [
  '1.1.1.1',
  '8.8.8.8',
  '93.184.216.34',
  '100.63.255.255',
  '100.128.0.1',
  '172.15.255.255',
  '172.32.0.1',
  '192.0.1.1',
  '192.167.255.255',
  '198.17.255.255',
  '198.20.0.1',
  '223.255.255.255',
  '2606:4700:4700::1111',
  '2a00:1450:4001:80b::200e',
  '2001:4860:4860::8888',
  '::ffff:8.8.8.8',
  '::ffff:808:808',
];

test('every special-purpose address, and every spelling of one, is refused', () => {
  for (const address of REFUSED) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test('ordinary public addresses, and the ranges next to the refused ones, are allowed', () => {
  for (const address of ALLOWED) {
    assert.equal(isPublicAddress(address), true, address);
  }
});
