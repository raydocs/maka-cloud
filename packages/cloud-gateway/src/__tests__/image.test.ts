import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dataUrlBytes, imageSize } from '../image.js';
import { dataUrl, gif, jpeg, png, webp } from './images.js';

test('the size of a PNG, JPEG, GIF and WebP is read from its header', () => {
  assert.deepEqual(imageSize(png(4096, 4096)), { width: 4096, height: 4096 });
  assert.deepEqual(imageSize(jpeg(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepEqual(imageSize(gif(320, 200)), { width: 320, height: 200 });
  assert.deepEqual(imageSize(webp(5000, 3)), { width: 5000, height: 3 });
});

test('a header that is cut short, empty or of another format gives no size', () => {
  assert.equal(imageSize(png(10, 10).subarray(0, 20)), undefined);
  assert.equal(imageSize(png(0, 10)), undefined);
  assert.equal(imageSize(Buffer.from('%PDF-1.7')), undefined);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), undefined);
  assert.equal(imageSize(new Uint8Array()), undefined);
});

test('only a base64 data URL gives bytes', () => {
  assert.deepEqual(imageSize(dataUrlBytes(dataUrl(gif(7, 9), 'image/gif')) ?? new Uint8Array()), {
    width: 7,
    height: 9,
  });
  assert.equal(dataUrlBytes('https://example.com/a.png'), undefined);
  assert.equal(dataUrlBytes('data:image/png,rawtext'), undefined);
});
