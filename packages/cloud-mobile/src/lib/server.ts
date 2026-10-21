/**
 * The address of the person's own cloud server. It must be https, except for the machine itself
 * (the simulator reaches the host as localhost, the Android emulator as 10.0.2.2) so a development
 * stack works. A token is never sent over plain http to anything else.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '10.0.2.2', '[::1]']);

export function normalizeServer(input: string): string {
  const text = input.trim();
  if (!text) throw new Error('Enter the address of your server.');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error('That does not look like a server address.');
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new Error('Use an https:// address. Plain http is only for this device.');
  if (url.username || url.password)
    throw new Error('Leave the user name and password out of the address.');
  return url.origin;
}
