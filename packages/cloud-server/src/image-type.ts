/** The image types a browser may be handed from a source we did not write; never SVG, which can carry script. */
export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export const IMAGE_TYPES: readonly ImageType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  bytes.length >= at + prefix.length && prefix.every((byte, i) => bytes[at + i] === byte);

/** What the bytes are, by their own first bytes. A declared type is never trusted. */
export function sniffImage(bytes: Uint8Array): ImageType | undefined {
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }
  return undefined;
}
