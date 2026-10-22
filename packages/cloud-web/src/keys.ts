import type { KeyboardEvent } from 'react';

/**
 * Enter sends the sentence, Shift+Enter starts a new line. While an input method is composing
 * (Chinese, Japanese, Korean), Enter confirms the composition and sends nothing.
 */
export function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}
