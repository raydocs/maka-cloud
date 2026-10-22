import { Button } from '@astryxdesign/core';
import { displayText, type InboxItem, suggestionLine } from '@maka-cloud/client';

/**
 * A task the employee noticed and proposes (T30): the verb-first title, what it will cost and where,
 * and two answers. "Do it" starts exactly one task, and the server reads the repository again first;
 * a card that moved is replaced here instead of acted on. Text written by other people is quoted
 * by the server before it gets here, and the task a tap starts asks before anything risky.
 */
export function SuggestionCard({
  item,
  disabled,
  onAnswer,
}: {
  item: InboxItem;
  disabled: boolean;
  onAnswer: (optionId: string) => void;
}) {
  const facts = item.suggestion;
  const options = [...item.options].sort((a, b) => Number(b.recommended) - Number(a.recommended));
  return (
    <article className="suggestion" aria-label={displayText(item.ask)}>
      <h3>{displayText(item.ask)}</h3>
      {facts ? (
        <>
          <p className="muted">{suggestionLine(facts)}</p>
          {facts.detail && <p className="suggestion-detail">{displayText(facts.detail)}</p>}
          {facts.external && (
            <p className="muted">
              Part of this was written by someone else. The task asks you before it does anything
              risky.
            </p>
          )}
        </>
      ) : null}
      {item.state === 'answering' ? (
        <p className="acknowledged" role="status">
          Your answer is chosen and is being delivered.
        </p>
      ) : (
        <div className="inbox-options">
          {options.map((option) => (
            <Button
              key={option.id}
              label={displayText(option.label)}
              variant={option.recommended ? 'primary' : 'secondary'}
              isDisabled={disabled}
              onClick={() => onAnswer(option.id)}
            />
          ))}
        </div>
      )}
    </article>
  );
}
