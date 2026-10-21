import { createHash, randomBytes } from 'node:crypto';

/**
 * What the host wrote down when it handed a message to the agent in a hook's answer: the message,
 * the text as the agent got it (a digest and a length), and a reference only the host and the
 * agent's own context know. It is kept with the task's session record, before the answer goes out.
 *
 * The kept transcript is evidence of delivery only through this record: a line counts when it
 * carries the opening tag with this message's key and this reference, followed by text of this
 * length and digest. Nothing in the transcript can stand in for that without the reference, which
 * the agent sees only in the message it was really given (the conversation is the agent's to write,
 * so a message that merely names a key proves nothing).
 */
export interface SteerReceipt {
  steerId: string;
  /** 32 hex characters, new for each handing. */
  ref: string;
  /** SHA-256 (hex) of the message text as the agent was given it. */
  digest: string;
  /** Its length in UTF-16 units, so the text can be cut out of a line again. */
  chars: number;
  at: number;
}

/** Receipts kept per task: the latest; an older message is long settled. */
export const MAX_STEER_RECEIPTS = 200;

const REF = /^[0-9a-f]{32}$/u;
const STEER_ID = /^[A-Za-z0-9_.:-]{1,64}$/u;

export const isSteerKey = (steerId: string): boolean => STEER_ID.test(steerId);

const digestOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** A receipt for handing `text` (as the agent will read it) under `steerId`. */
export function newReceipt(steerId: string, text: string, at: number): SteerReceipt {
  return {
    steerId,
    ref: randomBytes(16).toString('hex'),
    digest: digestOf(text),
    chars: text.length,
    at,
  };
}

/** Whether the receipt is for this text. */
export const receiptIsFor = (receipt: SteerReceipt, text: string): boolean =>
  receipt.chars === text.length && receipt.digest === digestOf(text);

/** The tag that opens a message: it carries the key and the receipt's reference. */
export const steerOpening = (steerId?: string, ref?: string): string =>
  steerId !== undefined && isSteerKey(steerId) && ref !== undefined && REF.test(ref)
    ? `<user_message id="${steerId}" ref="${ref}">`
    : '<user_message>';

export const STEER_CLOSING = '</user_message>';

/** The strings of a parsed JSON value. */
function* strings(value: unknown, depth = 0): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (depth < 12 && Array.isArray(value))
    for (const item of value) yield* strings(item, depth + 1);
  else if (depth < 12 && typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) yield* strings(item, depth + 1);
  }
}

/**
 * The receipts one transcript line (a JSON object) proves were delivered: those whose opening tag
 * is in one of its strings, followed by the text of the recorded length and digest and the closing
 * tag.
 */
export function receiptsShownIn(line: string, receipts: Iterable<SteerReceipt>): SteerReceipt[] {
  const candidates = [...receipts].filter((receipt) => line.includes(receipt.ref));
  if (candidates.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const found: SteerReceipt[] = [];
  for (const text of strings(parsed)) {
    for (const receipt of candidates) {
      if (found.includes(receipt)) continue;
      const opening = `${steerOpening(receipt.steerId, receipt.ref)}\n`;
      let from = text.indexOf(opening);
      while (from >= 0) {
        const start = from + opening.length;
        const body = text.slice(start, start + receipt.chars);
        if (
          body.length === receipt.chars &&
          text.startsWith(`\n${STEER_CLOSING}`, start + receipt.chars) &&
          digestOf(body) === receipt.digest
        ) {
          found.push(receipt);
          break;
        }
        from = text.indexOf(opening, from + 1);
      }
    }
  }
  return found;
}
