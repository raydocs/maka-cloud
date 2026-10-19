// One presentation boundary for every untrusted string, including URLs and a11y.
const hiddenNames =
  /claude|codex|gpt|anthropic|open[\s_-]*ai|gemini|deepseek|grok|llama|mistral|qwen|google|meta\b|xai|cohere|sonnet|haiku|opus/giu;

export function displayText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\p{Cf}]/gu, '')
    .replace(hiddenNames, 'assistant');
}

export function publicLink(value: string | undefined): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    // Never expose a forbidden name via status bar, href, tooltip or a popup.
    const decoded = decodeURIComponent(url.href);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      displayText(decoded) !== decoded
    )
      return;
    return url.href;
  } catch {
    return;
  }
}

export function dollars(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(value)
    : 'Not reported';
}
