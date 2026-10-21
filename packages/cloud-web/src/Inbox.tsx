import { Button } from '@astryxdesign/core';
import { useState } from 'react';
import { displayText, type InboxItem, inboxCardModel, visibleInbox } from '@maka-cloud/client';

export function InboxCard({
  item,
  disabled,
  onAnswer,
}: {
  item: InboxItem;
  disabled: boolean;
  onAnswer: (optionId: string, text?: string) => void;
}) {
  const [note, setNote] = useState('');
  const card = inboxCardModel(item);
  return (
    <section className="question" aria-label={card.heading}>
      <div className="section-heading">
        <span className={`status-mark ${item.state === 'open' ? 'attention' : 'succeeded'}`} />
        {card.heading}
      </div>
      {/* The supervisor's own sentence, including its check label, as sent. */}
      <h3>{card.text}</h3>
      {card.cannotApproveHere && (
        <p className="muted">This card cannot be shown exactly, so it cannot be approved here.</p>
      )}
      {card.evidence.length > 0 && (
        <ul className="muted">
          {card.evidence.map((line, index) => (
            <li
              key={`${item.itemId}-${index}`}
              className={line.kind === 'action' ? 'held-action' : undefined}
            >
              {line.kind === 'artifact' && line.text}
              {line.kind === 'action' && (
                <>
                  Held until you answer: {line.tool} <code>{line.args}</code>
                </>
              )}
              {line.kind === 'link' &&
                (line.href ? (
                  <a href={line.href} target="_blank" rel="noreferrer noopener">
                    {line.label} ↗
                  </a>
                ) : (
                  line.label
                ))}
            </li>
          ))}
        </ul>
      )}
      {card.answering ? (
        <p className="acknowledged" role="status">
          {card.answering}
        </p>
      ) : (
        <>
          {item.allowText && (
            <label className="note-label">
              Additional context (optional)
              <textarea
                rows={2}
                maxLength={4000}
                value={note}
                onChange={(e) => setNote(displayText(e.target.value))}
                disabled={disabled}
              />
            </label>
          )}
          <div className="inbox-options">
            {card.options.map((option) => (
              <Button
                key={option.id}
                label={displayText(option.label)}
                variant={option.recommended ? 'primary' : 'secondary'}
                isDisabled={disabled}
                onClick={() => onAnswer(option.id, note.trim() || undefined)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function InboxPanel({
  items,
  openQuestions,
  disabled,
  onAnswer,
}: {
  items: InboxItem[];
  openQuestions: ReadonlySet<string>;
  disabled: boolean;
  onAnswer: (item: InboxItem, optionId: string, text?: string) => void;
}) {
  const { live, closed } = visibleInbox(items, openQuestions);
  if (live.length === 0 && closed.length === 0) return null;
  return (
    <section className="inbox" aria-label="Needs you">
      {live.length > 0 && <h2>Needs you ({live.length})</h2>}
      {live.map((item) => (
        <InboxCard
          key={item.itemId}
          item={item}
          disabled={disabled}
          onAnswer={(optionId, text) => onAnswer(item, optionId, text)}
        />
      ))}
      {closed.length > 0 && (
        <details>
          <summary>Done ({closed.length})</summary>
          <ul>
            {closed.map((item) => (
              <li key={item.itemId}>{displayText(item.ask)}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
