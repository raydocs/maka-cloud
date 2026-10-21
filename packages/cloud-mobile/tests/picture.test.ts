import { base64Of } from '@/lib/picture';

test('bytes become the same base64 as the web, with padding', () => {
  const bytes = (text: string) => Uint8Array.from(Buffer.from(text));
  expect(base64Of(bytes(''))).toBe('');
  expect(base64Of(bytes('f'))).toBe('Zg==');
  expect(base64Of(bytes('fo'))).toBe('Zm8=');
  expect(base64Of(bytes('foo'))).toBe('Zm9v');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  expect(base64Of(Uint8Array.from(png))).toBe(png.toString('base64'));
});
