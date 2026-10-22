import type { Mailer } from '@maka-cloud/server';

export interface HttpMailerOptions {
  /** The owner's mail service: it takes a POST of `{from, to, subject, text}` with a bearer key. */
  apiUrl: string;
  /** Read from the environment by the stack and kept in memory; never logged or put in an error. */
  apiKey: string;
  from: string;
  /** Tests replace it. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Sends sign-in mail through an HTTPS mail API in the shape most of them share (the owner picks the
 * service: any that takes this JSON with a bearer key works). A refusal or a failure to connect is an
 * error with no detail: what the service answered could carry the key or an address.
 */
export function createHttpMailer(options: HttpMailerOptions): Mailer {
  const send = options.fetch ?? fetch;
  return {
    async send(message) {
      let status: number;
      try {
        const response = await send(options.apiUrl, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: options.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
        status = response.status;
        await response.body?.cancel().catch(() => undefined);
      } catch {
        throw new Error('The mail service could not be reached');
      }
      if (status < 200 || status >= 300) throw new Error(`The mail service answered ${status}`);
    },
  };
}
