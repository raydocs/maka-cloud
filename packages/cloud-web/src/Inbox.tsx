import { Button } from '@astryxdesign/core';
import { useState } from 'react';
import {
  displayText,
  exactText,
  type InboxEvidence,
  type InboxItem,
  publicLink,
  visibleInbox,
} from '@maka-cloud/client';

const HEADING: Record<string, string> = {
  approval: 'Needs your approval',
  budget: 'Needs your decision on the budget',
  decision: 'Needs your decision',
  blocked: 'Might be stuck',
  verification_failed: 'A check of the result failed',
  finished: 'Finished',
};

function Evidence({ evidence, exact }: { evidence: InboxEvidence; exact: boolean }) {
  if (evidence.kind === 'artifact') {
    return <li>Result file: {displayText(evidence.name)}</li>;
  }
  if (evidence.kind === 'action') {
    return (
      <li className="held-action">
        Held until you answer: {exact ? evidence.tool : displayText(evidence.tool)}{' '}
        <code>{exact ? evidence.args : displayText(evidence.args)}</code>
      </li>
    );
  }
  const href = publicLink(evidence.url);
  return (
    <li>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {displayText(evidence.label)} ↗
        </a>
      ) : (
        displayText(evidence.label)
      )}
    </li>
  );
}

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
  // An approval binds the card's exact text: it is shown as sent, with the held call's arguments,
  // and a card that cannot be shown exactly cannot be approved here (T15).
  const approval = item.kind === 'approval';
  const exact = approval ? exactText(item.ask) : undefined;
  const options = [...item.options]
    .filter((option) => !approval || exact !== undefined || option.id !== 'approve')
    .sort((a, b) => Number(b.recommended) - Number(a.recommended));
  return (
    <section className="question" aria-label={HEADING[item.kind] ?? 'Needs you'}>
      <div className="section-heading">
        <span className={`status-mark ${item.state === 'open' ? 'attention' : 'succeeded'}`} />
        {HEADING[item.kind] ?? 'Needs you'}
      </div>
      {/* The supervisor's own sentence, including its check label, as sent. */}
      <h3>{exact ?? displayText(item.ask)}</h3>
      {approval && exact === undefined && (
        <p className="muted">This card cannot be shown exactly, so it cannot be approved here.</p>
      )}
      {item.evidence.length > 0 && (
        <ul className="muted">
          {item.evidence.map((evidence, index) => (
            <Evidence
              key={`${item.itemId}-${index}`}
              evidence={evidence}
              exact={exact !== undefined}
            />
          ))}
        </ul>
      )}
      {item.state === 'answering' ? (
        <p className="acknowledged" role="status">
          {item.delivery === 'retrying'
            ? 'Your answer is chosen. Delivering it is taking a few tries, and it will keep trying.'
            : 'Your answer is chosen and is being delivered.'}
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
            {options.map((option) => (
              <Button
                key={option.id}
                label={displayText(option.label)}
                variant={option.recommended ? 'primary' : 'secondary'}
                isDisabled={disabled}
                onClick={() => onAnswer(option.id, note.trim() || undefined)}
              />
            ))}
          </div>
          {options.some((option) => option.recommended) && (
            <p className="muted">The filled button is the recommended answer.</p>
          )}
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
