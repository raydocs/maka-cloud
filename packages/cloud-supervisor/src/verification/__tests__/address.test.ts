import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPublicAddress } from '../address.js';

const PRIVATE = [
  '0.0.0.0',
  '0.1.2.3',
  '10.0.0.1',
  '10.255.255.255',
  '100.64.0.1',
  '100.127.255.254',
  '127.0.0.1',
  '127.255.255.254',
  '169.254.169.254',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.1',
  '192.0.2.7',
  '192.168.0.1',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.9',
  '203.0.113.9',
  '224.0.0.1',
  '239.255.255.255',
  '240.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  '::2',
  'fc00::1',
  'fd12:3456::1',
  'fe80::1',
  'fe80::1%eth0',
  'fec0::1',
  'ff02::1',
  '2001:db8::1',
  '2001::1',
  '100::1',
  '::ffff:127.0.0.1',
  '::ffff:10.1.2.3',
  '::ffff:169.254.169.254',
  '::ffff:7f00:1',
  '::127.0.0.1',
  '64:ff9b::127.0.0.1',
  '64:ff9b::a00:1',
  '64:ff9b:1::1',
  '2002:7f00:1::1',
  '2002:a9fe:a9fe::1',
  '[::1]',
  'not an address',
  '',
  '1.2.3',
  '1.2.3.4.5',
  '999.1.1.1',
];

const PUBLIC = [
  '1.1.1.1',
  '8.8.8.8',
  '93.184.216.34',
  '172.15.255.255',
  '172.32.0.1',
  '100.63.255.255',
  '100.128.0.1',
  '198.17.255.255',
  '198.20.0.1',
  '223.255.255.255',
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
  '::ffff:8.8.8.8',
  '64:ff9b::808:808',
  '2002:808:808::1',
];

test('private, loopback, link-local, reserved and malformed addresses are not public', () => {
  for (const address of PRIVATE) {
    assert.equal(isPublicAddress(address), false, `${address} must be refused`);
  }
});

test('ordinary public addresses, and the edges next to the blocked ranges, are public', () => {
  for (const address of PUBLIC) {
    assert.equal(isPublicAddress(address), true, `${address} must be allowed`);
  }
});
