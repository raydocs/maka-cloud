import { useEffect, useState } from 'react';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 of some bytes; Hermes has no `Buffer`, and `btoa` wants a string of characters. */
export function base64Of(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const chunk = (a << 16) | (b << 8) | c;
    out += ALPHABET[(chunk >> 18) & 63];
    out += ALPHABET[(chunk >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(chunk >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? ALPHABET[chunk & 63] : '=';
  }
  return out;
}

/** Larger pictures are not decoded on the phone: they would freeze the screen and can run it out of memory. */
export const MAX_PICTURE_BYTES = 4_000_000;

/** A picture's bytes as a `data:` URI the Image component can draw. */
export async function dataUriOf(blob: Blob): Promise<string> {
  const type = blob.type || 'image/png';
  if (blob.size > MAX_PICTURE_BYTES) throw new Error('The picture is too large to show here.');
  if (typeof blob.arrayBuffer === 'function')
    return `data:${type};base64,${base64Of(new Uint8Array(await blob.arrayBuffer()))}`;
  // A Blob without `arrayBuffer` is React Native's own, which its FileReader can read.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The picture could not be read'));
    reader.readAsDataURL(blob);
  });
}

/** The URI of a picture, or '' while it is being read; `failed` once it could not be (too large, unreadable). */
export function usePicture(blob: Blob | undefined): { uri: string; failed: boolean } {
  const [state, setState] = useState({ uri: '', failed: false });
  useEffect(() => {
    let current = true;
    if (!blob) {
      setState({ uri: '', failed: false });
      return;
    }
    dataUriOf(blob).then(
      (uri) => current && setState({ uri, failed: false }),
      () => current && setState({ uri: '', failed: true }),
    );
    return () => {
      current = false;
    };
  }, [blob]);
  return state;
}

export const useBlobUri = (blob: Blob | undefined): string => usePicture(blob).uri;
