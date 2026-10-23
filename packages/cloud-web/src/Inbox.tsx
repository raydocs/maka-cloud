import { useT } from './i18n';
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
  const { t, shared, choiceLabel } = useT();
  const [note, setNote] = useState('');
  const [noting, setNoting] = useState(false);
  const card = inboxCardModel(item);
  return (
    <section className="question" aria-label={shared(card.heading)}>
      <div className="section-heading">
        <span className={`status-mark ${item.state === 'open' ? 'attention' : 'succeeded'}`} />
        {shared(card.heading)}
      </div>
      {/* The supervisor's own sentence, including its check label, as sent. */}
      <h3>{card.text}</h3>
      {card.cannotApproveHere && (
        <p className="muted">
          {t('This card cannot be shown exactly, so it cannot be approved here.')}
        </p>
      )}
      {card.evidence.length > 0 && !(resultShown && item.kind === 'finished') && (
        <ul className="muted">
          {card.evidence.map((line, index) => (
            <li
              key={`${item.itemId}-${index}`}
              className={line.kind === 'action' ? 'held-action' : undefined}
            >
              {line.kind === 'artifact' && shared(line.text)}
              {line.kind === 'action' && (
                <>
                  {t('Held until you answer:')} {line.tool} <code>{line.args}</code>
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
          {shared(card.answering)}
        </p>
      ) : (
        <>
          {item.allowText && !noting && (
            <button type="button" className="quiet-action" onClick={() => setNoting(true)}>
              {t('Add a note')}
            </button>
          )}
          {item.allowText && noting && (
            <label className="note-label">
              {t('Note')}
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
                label={choiceLabel(option.id, option.label)}
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
  const { t, shared, choiceLabel } = useT();
  const card = inboxCardModel(item);
  const verb = shared(verbOf(item.kind));
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
            ? t('Checked by a second agent')
            : t('Not checked by a second agent')}
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
              {pullRequestName(line.href) ? shared(pullRequestName(line.href)!) : line.label}{' '}
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
          {shared(card.answering)}
        </p>
      ) : (
        <div className="inbox-options">
          {card.options.map((option) => (
            <Button
              key={option.id}
              label={choiceLabel(option.id, option.label)}
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
  const { t } = useT();
  const { live, closed } = visibleInbox(items, openQuestions);
  if (live.length === 0 && closed.length === 0) return null;
  return (
    <section className="inbox" aria-label={t('Needs you')}>
      {live.length > 0 && <h2>{t('Needs you ({count})', { count: live.length })}</h2>}
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
          <summary>{t('Done ({count})', { count: closed.length })}</summary>
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
