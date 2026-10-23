import { useT } from './i18n';
import { displayText, failureWords, type FailureWords } from '@maka-cloud/client';

/** Why a task failed, in a plain sentence and a next step; the server's own words behind "Details". */
export function FailureNote({ reason }: { reason: string }) {
  const { t, shared } = useT();
  const words = failureWords(displayText(reason));
  const hasServerNext =
    /^needs you:/iu.test(reason.trim()) &&
    reason.trim().slice('needs you:'.length).split(';').slice(1).join(';').trim() !== '';
  return (
    <div className="failure-note">
      <p className="failure">
        {localizedSentence(words, reason, shared)}{' '}
        <span className="failure-next">{hasServerNext ? words.next : shared(words.next)}</span>
      </p>
      {/* A reason that already was the sentence is not repeated. */}
      {words.detail !== words.sentence && (
        <details className="failure-detail">
          <summary>{t('Details')}</summary>
          <code>{words.detail}</code>
        </details>
      )}
    </div>
  );
}

/** Prose written by the server stays prose, even if it happens to equal a catalogue entry. */
export function localizedSentence(
  words: FailureWords,
  reason: string,
  shared: (text: string) => string,
) {
  const lower = reason.trim().toLowerCase();
  const generated =
    !lower.startsWith('needs you:') &&
    ((/\bbudget\b/u.test(lower) && /reached|used up|spent|exceeded/u.test(lower)) ||
      /timed out|time ?out|run time|deadline/u.test(lower) ||
      /^(invalid manifest:|runner exited without reporting|runner error:)/u.test(lower) ||
      !(/^[A-Z][^:]*(?:[.!?]|$)/u.test(reason.trim()) && !/[{}<>\\]|error:/iu.test(reason)));
  return generated ? shared(words.sentence) : words.sentence;
}
