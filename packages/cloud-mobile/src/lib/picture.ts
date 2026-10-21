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

/** A picture's bytes as a `data:` URI the Image component can draw. */
export async function dataUriOf(blob: Blob): Promise<string> {
  const type = blob.type || 'image/png';
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

/** The URI of a picture, or '' while it is being read or if it cannot be. */
export function useBlobUri(blob: Blob | undefined): string {
  const [uri, setUri] = useState('');
  useEffect(() => {
    let current = true;
    if (!blob) {
      setUri('');
      return;
    }
    dataUriOf(blob).then(
      (next) => current && setUri(next),
      () => current && setUri(''),
    );
    return () => {
      current = false;
    };
  }, [blob]);
  return uri;
}
