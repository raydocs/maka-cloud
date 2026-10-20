/** A trusted, server-side adapter. Never return sandbox URLs or credentials to a browser. */
export interface ComputerSource {
  available(taskId: string): Promise<boolean>;
  /**
   * Latest desktop image (PNG/JPEG, base64 only) and terminal output. The adapter
   * owns the instabox VNC/PTY connection and must close it when signal aborts.
   * Frames are ephemeral, not conversation history; reconnect sends a fresh image.
   */
  watch(taskId: string, signal: AbortSignal): AsyncIterable<ComputerFrame>;
  /** Must abort pending writes on signal, and never retain input for later replay. */
  input(taskId: string, input: ComputerInput, signal: AbortSignal): Promise<void>;
}

export interface ComputerFrame {
  desktop?: { mime: 'image/png' | 'image/jpeg'; base64: string };
  terminal?: string;
}

export type ComputerInput =
  | { type: 'terminal'; text: string }
  | { type: 'key'; key: string }
  | { type: 'pointer'; x: number; y: number; button: 0 | 1 | 2 };
