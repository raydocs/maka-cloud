/** The instabox error envelope: `{"error": {code, message, requestId, retryable, operationId}}`. */
export interface InstaboxErrorEnvelope {
  code: string;
  message: string;
  requestId?: string;
  retryable?: boolean;
  operationId?: string | null;
}

export class InstaboxApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly operationId: string | null;

  constructor(status: number, envelope: InstaboxErrorEnvelope) {
    super(`instabox ${envelope.code} (HTTP ${status}): ${envelope.message}`);
    this.name = 'InstaboxApiError';
    this.status = status;
    this.code = envelope.code;
    this.requestId = envelope.requestId;
    this.retryable = envelope.retryable === true;
    this.operationId = envelope.operationId ?? null;
  }
}

/** The request never produced a response (connection reset, DNS, TLS, client timeout). */
export class InstaboxTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InstaboxTransportError';
  }
}

/**
 * An operation that did not succeed. `outcome` says what is known: 'failed' means instabox reported the
 * operation failed (a create left no machine); 'unknown' means the wait ran out while it was still
 * running, so it may yet finish and the machine may exist.
 */
export class InstaboxOperationError extends Error {
  constructor(
    readonly operationId: string,
    message: string,
    readonly outcome: 'failed' | 'unknown' = 'failed',
  ) {
    super(message);
    this.name = 'InstaboxOperationError';
  }
}

export function isInstaboxEnvelope(value: unknown): value is { error: InstaboxErrorEnvelope } {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

/** The account's sandbox limit (or credit) refused a create: `429 quota_exceeded`. */
export function isQuotaExceeded(error: unknown): boolean {
  return (
    error instanceof InstaboxApiError && error.status === 429 && error.code === 'quota_exceeded'
  );
}
