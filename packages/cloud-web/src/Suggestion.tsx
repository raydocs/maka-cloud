import { useT } from './i18n';
import { Button } from '@astryxdesign/core';
import { displayText, dollars, type InboxItem } from '@maka-cloud/client';

/**
 * A task Maka noticed and proposes (T30): the verb-first title, what it will cost and where,
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
  const { t, shared, choiceLabel } = useT();
  const facts = item.suggestion;
  const options = [...item.options].sort((a, b) => Number(b.recommended) - Number(a.recommended));
  const title = displayText(item.ask);
  // An action sentence: the title's first word (titles are verb-first) is the recommended answer's
  // button, as in "[Fix] the failing test on main". Its name still says what it does ("Do it: …").
  const act = facts && item.state !== 'answering' ? options.find((o) => o.recommended) : undefined;
  const [verb = '', ...rest] = title.split(' ');
  return (
    <article className="suggestion" aria-label={title}>
      {act ? (
        <h3 className="action-sentence">
          <button
            type="button"
            className="verb-chip"
            aria-label={`${choiceLabel(act.id, act.label)}: ${title}`}
            disabled={disabled}
            onClick={() => onAnswer(act.id)}
          >
            {verb}
          </button>{' '}
          {rest.join(' ')}
        </h3>
      ) : (
        <h3>{title}</h3>
      )}
      {facts ? (
        <>
          <p className="muted">
            {t('{mode} · about {cost}{typical} · {repo}', {
              mode: shared({ quick: 'Quick', standard: 'Standard', deep: 'Deep' }[facts.mode]),
              cost: shared(dollars(facts.estimateUsd)),
              typical: facts.typical ? t(' (typical)') : '',
              repo: displayText(facts.repo),
            })}
          </p>
          {facts.detail && <p className="suggestion-detail">{displayText(facts.detail)}</p>}
          {facts.external && (
            <p className="muted">
              {t(
                'Part of this was written by someone else. The task asks you before it does anything risky.',
              )}
            </p>
          )}
        </>
      ) : null}
      {item.state === 'answering' ? (
        <p className="acknowledged" role="status">
          {t('Sending…')}
        </p>
      ) : (
        <div className="inbox-options">
          {options
            .filter((option) => option !== act)
            .map((option) =>
              act ? (
                <button
                  key={option.id}
                  type="button"
                  className="quiet-action"
                  disabled={disabled}
                  onClick={() => onAnswer(option.id)}
                >
                  {choiceLabel(option.id, option.label)}
                </button>
              ) : (
                <Button
                  key={option.id}
                  label={choiceLabel(option.id, option.label)}
                  variant={option.recommended ? 'primary' : 'secondary'}
                  isDisabled={disabled}
                  onClick={() => onAnswer(option.id)}
                />
              ),
            )}
        </div>
      )}
    </article>
  );
}
