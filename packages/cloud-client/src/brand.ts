/**
 * The product's name, as people see it on the web and in the phone apps. One place, so a rename is
 * one edit. Package names, settings (`MAKA_CLOUD_*`), storage keys and app identifiers are internal
 * and stay as they are: changing an app's bundle identifier would orphan installed copies.
 */
export const BRAND = {
  /** In sentences: "What Maka remembers about you", and as the author of the assistant's messages. */
  name: 'Maka',
  /** The lowercase wordmark at the top of every screen. */
  wordmark: 'maka',
  /** After the name in the browser tab. */
  tagline: 'your work, together',
} as const;
