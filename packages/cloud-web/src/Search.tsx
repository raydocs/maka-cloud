import { type CloudClient, type Conversation, displayText } from '@maka-cloud/client';
import { useEffect, useRef, useState } from 'react';
import { useT } from './i18n';

export function ConversationSearch({
  client,
  known,
  query,
  onChoose,
}: {
  client: CloudClient;
  /** The conversations already on the page: listed at once while a fresh list loads. */
  known?: Conversation[];
  query: string;
  onChoose: (id: string) => void;
}) {
  const { t } = useT();
  const sequence = useRef(0);
  const [attempt, retry] = useState(0);
  const [result, setResult] = useState<{ conversations?: Conversation[]; error?: boolean }>(() =>
    known?.length ? { conversations: known } : {},
  );
  const words = query.trim();
  useEffect(() => {
    const id = ++sequence.current;
    setResult((shown) => (shown?.conversations ? shown : {}));
    void client.listConversations().then(
      ({ conversations }) => {
        if (sequence.current !== id) return;
        setResult({ conversations });
      },
      () => {
        if (sequence.current === id) setResult({ error: true });
      },
    );
    return () => {
      sequence.current++;
    };
  }, [client, attempt]);
  if (!result?.conversations && !result?.error) return <p role="status">{t('Loading')}</p>;
  if (result?.error)
    return (
      <p>
        {t('Search could not be loaded.')}{' '}
        <button type="button" onClick={() => retry((n) => n + 1)}>
          {t('Retry now')}
        </button>
      </p>
    );
  // With nothing typed, every conversation is listed, as before search had states.
  const hits = result?.conversations?.filter((c) =>
    (c.title ?? '').toLocaleLowerCase().includes(words.toLocaleLowerCase()),
  );
  if (!hits?.length)
    return (
      <p>
        {words
          ? t('No matches for “{query}”.', { query: words })
          : t('Search conversation titles.')}
      </p>
    );
  return (
    <>
      {hits.map((c) => (
        <button
          className="quiet-action"
          type="button"
          key={c.conversationId}
          onClick={() => onChoose(c.conversationId)}
        >
          {displayText(c.title ?? t('Untitled conversation'))}
        </button>
      ))}
    </>
  );
}
