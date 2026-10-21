import { normalizeServer } from '@/lib/server';

test('a server address is https, or this machine over http for development', () => {
  expect(normalizeServer('maka.example.com')).toBe('https://maka.example.com');
  expect(normalizeServer('  https://maka.example.com/some/path?x=1 ')).toBe(
    'https://maka.example.com',
  );
  expect(normalizeServer('http://localhost:4174')).toBe('http://localhost:4174');
  expect(normalizeServer('http://10.0.2.2:4174/')).toBe('http://10.0.2.2:4174');
});

test('a token is never sent in the clear to anything else', () => {
  expect(() => normalizeServer('http://maka.example.com')).toThrow(/https/u);
  expect(() => normalizeServer('http://192.168.1.20:4174')).toThrow(/https/u);
  expect(() => normalizeServer('ftp://maka.example.com')).toThrow(/https/u);
  expect(() => normalizeServer('https://user:secret@maka.example.com')).toThrow(/user name/u);
  expect(() => normalizeServer('')).toThrow(/address/u);
  expect(() => normalizeServer('https://')).toThrow();
});
