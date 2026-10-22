import { displayText, failureWords } from '@maka-cloud/client';

/** Why a task failed, in a plain sentence and a next step; the server's own words behind "Details". */
export function FailureNote({ reason }: { reason: string }) {
  const words = failureWords(displayText(reason));
  return (
    <div className="failure-note">
      <p className="failure">
        {words.sentence} <span className="failure-next">{words.next}</span>
      </p>
      {/* A reason that already was the sentence is not repeated. */}
      {words.detail !== words.sentence && (
        <details className="failure-detail">
          <summary>Details</summary>
          <code>{words.detail}</code>
        </details>
      )}
    </div>
  );
}
