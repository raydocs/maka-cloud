declare module 'web-push' {
  interface Subscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
  interface RequestOptions {
    vapidDetails?: { subject: string; publicKey: string; privateKey: string };
    TTL?: number;
    urgency?: 'very-low' | 'low' | 'normal' | 'high';
    topic?: string;
  }
  interface RequestDetails {
    method: string;
    endpoint: string;
    headers: Record<string, string | number>;
    body: Buffer | null;
  }
  const webpush: {
    generateRequestDetails(
      subscription: Subscription,
      payload: string | Buffer,
      options?: RequestOptions,
    ): RequestDetails;
    generateVAPIDKeys(): { publicKey: string; privateKey: string };
  };
  export default webpush;
}
