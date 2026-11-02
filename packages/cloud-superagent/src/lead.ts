export interface LeadMessage {
  tenantId: string;
  text: string;
  stale?: boolean;
  workerId?: string | null;
}

/** The only outbound user channel. Never passed to a WorkerHandler. */
export interface LeadPort {
  speak(message: LeadMessage): Promise<void>;
}

export class RecordingLead implements LeadPort {
  readonly messages: LeadMessage[] = [];

  async speak(message: LeadMessage): Promise<void> {
    this.messages.push({ ...message });
  }
}

export class SilentLead implements LeadPort {
  async speak(): Promise<void> {}
}

/** A worker result that tried to address the human. */
export function workerOutboundText(result: { userMessage?: string }): string | undefined {
  const text = result.userMessage?.trim();
  return text ? text : undefined;
}
