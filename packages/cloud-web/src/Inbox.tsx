import { Button } from '@astryxdesign/core';
import { ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import {
  displayText,
  type InboxItem,
  inboxCardModel,
  pullRequestName,
  verbOf,
  visibleInbox,
} from '@maka-cloud/client';

export function InboxCard({
  item,
  disabled,
  onAnswer,
  resultShown = false,
}: {
  item: InboxItem;
  disabled: boolean;
  onAnswer: (optionId: string, text?: string) => void;
  /** The task's own result card is on screen, so its files and links are not listed again. */
  resultShown?: boolean;
}) {
  const [note, setNote] = useState('');
  const [noting, setNoting] = useState(false);
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
      {card.evidence.length > 0 && !(resultShown && item.kind === 'finished') && (
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
                    {line.label}{' '}
                    <ArrowUpRight aria-hidden="true" size={14} className="icon-inline" />
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
          {item.allowText && !noting && (
            <button type="button" className="quiet-action" onClick={() => setNoting(true)}>
              Add a note
            </button>
          )}
          {item.allowText && noting && (
            <label className="note-label">
              Note
              <textarea
                rows={2}
                maxLength={4000}
                value={note}
                onChange={(e) => setNote(displayText(e.target.value))}
                disabled={disabled}
                // The person just asked to write the note.
                autoFocus
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

/**
 * A finished task on Home, read as an action sentence: "[Review] Fix the flaky login test", then
 * the outcome, whether a second agent checked it, and its files and links as small chips. The verb
 * opens the task; the answer buttons are the supervisor's own.
 */
export function ResultCard({
  item,
  parts,
  disabled,
  onAnswer,
  onReview,
}: {
  item: InboxItem;
  /** The supervisor's sentence, split by `finishedParts`. */
  parts: { title: string; check: string; outcome: string };
  disabled: boolean;
  onAnswer: (optionId: string) => void;
  onReview: () => void;
}) {
  const card = inboxCardModel(item);
  const verb = verbOf(item.kind);
  return (
    <article className="result-card" aria-label={`${verb}: ${parts.title}`}>
      <h3 className="action-sentence">
        <button
          type="button"
          className="verb-chip"
          aria-label={`${verb}: ${parts.title}`}
          onClick={onReview}
        >
          {verb}
        </button>{' '}
        {parts.title}
      </h3>
      <p>{parts.outcome}</p>
      <div className="result-meta">
        <span className={parts.check === 'independently checked' ? 'checked' : 'unchecked'}>
          {parts.check === 'independently checked'
            ? 'Checked by a second agent'
            : 'Not checked by a second agent'}
        </span>
        {card.evidence.map((line, index) =>
          line.kind === 'link' && line.href ? (
            <a
              key={`${item.itemId}-${index}`}
              className="evidence-chip"
              href={line.href}
              target="_blank"
              rel="noreferrer noopener"
            >
              {pullRequestName(line.href) ?? line.label}{' '}
              <ArrowUpRight aria-hidden="true" size={14} className="icon-inline" />
            </a>
          ) : line.kind === 'artifact' ? (
            <span key={`${item.itemId}-${index}`} className="evidence-chip">
              {line.text.replace(/^Result file: /u, '')}
            </span>
          ) : null,
        )}
      </div>
      {card.answering ? (
        <p className="acknowledged" role="status">
          {card.answering}
        </p>
      ) : (
        <div className="inbox-options">
          {card.options.map((option) => (
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

export function InboxPanel({
  items,
  openQuestions,
  disabled,
  onAnswer,
  shownResults,
}: {
  items: InboxItem[];
  openQuestions: ReadonlySet<string>;
  disabled: boolean;
  onAnswer: (item: InboxItem, optionId: string, text?: string) => void;
  /** Tasks whose result card is already on screen beside the inbox. */
  shownResults?: ReadonlySet<string>;
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
          resultShown={item.taskId !== null && Boolean(shownResults?.has(item.taskId))}
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
