/** The pixel size an image file declares in its header, for the formats the vendors accept. */
export interface ImageSize {
  width: number;
  height: number;
}

function u16be(b: Uint8Array, at: number): number {
  return (b[at] << 8) | b[at + 1];
}

function u16le(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

function u24le(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
}

function u32be(b: Uint8Array, at: number): number {
  return ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
}

function ascii(b: Uint8Array, at: number, text: string): boolean {
  if (b.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

function sized(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function png(b: Uint8Array): ImageSize | undefined {
  if (b.length < 24 || !ascii(b, 1, 'PNG\r\n\x1a\n') || b[0] !== 0x89 || !ascii(b, 12, 'IHDR')) {
    return undefined;
  }
  return sized(u32be(b, 16), u32be(b, 20));
}

function gif(b: Uint8Array): ImageSize | undefined {
  if (b.length < 10 || !(ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) return undefined;
  return sized(u16le(b, 6), u16le(b, 8));
}

function webp(b: Uint8Array): ImageSize | undefined {
  if (!ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return undefined;
  if (ascii(b, 12, 'VP8 ') && b.length >= 30) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
    return sized(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (ascii(b, 12, 'VP8L') && b.length >= 25) {
    if (b[20] !== 0x2f) return undefined;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (ascii(b, 12, 'VP8X') && b.length >= 30) {
    return sized(u24le(b, 24) + 1, u24le(b, 27) + 1);
  }
  return undefined;
}

/** Start-of-frame markers, the ones that carry the frame size. */
function isFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpeg(b: Uint8Array): ImageSize | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 3 < b.length) {
    if (b[at] !== 0xff) return undefined;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // The image data or its end came before any frame header.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16be(b, at + 2);
    if (length < 2) return undefined;
    if (isFrameMarker(marker)) {
      if (at + 9 > b.length) return undefined;
      return sized(u16be(b, at + 7), u16be(b, at + 5));
    }
    at += 2 + length;
  }
  return undefined;
}

/** The size a PNG, JPEG, GIF or WebP file declares, or undefined when it cannot be read. */
export function imageSize(bytes: Uint8Array): ImageSize | undefined {
  return png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes);
}

/** The bytes of a `data:<type>;base64,<data>` URL, or undefined for anything else. */
export function dataUrlBytes(url: string): Uint8Array | undefined {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma === -1) return undefined;
  const header = url.slice(5, comma).split(';');
  if (!header.includes('base64')) return undefined;
  return Buffer.from(url.slice(comma + 1), 'base64');
}
