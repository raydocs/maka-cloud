import { displayText, type TaskView } from '@maka-cloud/client';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Card, Field, PillButton, QuietButton, Screen, StatusMark, T } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useWorkspace } from '@/lib/session';
import { TOUCH } from '@/lib/theme';

/** The conversations whose tasks are read for search: the most recent ones, as Home reads them. */
const TASK_CONVERSATIONS = 20;

const TONE = { succeeded: 'ok', failed: 'bad', cancelled: 'idle', paused: 'attention' } as const;

/** Lowercase and without the marks Chinese and Latin text can differ by, for a forgiving match. */
const fold = (text: string) => text.normalize('NFKC').toLocaleLowerCase();

/**
 * Search, opened from the round button at the top left. It looks through what this phone already
 * has: the conversations' titles, and the titles and outcomes of their tasks (read with the same
 * calls Home makes). No search endpoint on the server.
 */
export default function Search() {
  const { client, conversations, open } = useWorkspace();
  const router = useRouter();
  const { t: say } = useT();
  const [query, setQuery] = useState('');
  // Each conversation's tasks as read; a conversation whose read failed is listed, so "nothing
  // matches" is said only when every read succeeded, and a retry reads just those again.
  const [read, setRead] = useState<Record<string, TaskView[]>>({});
  const [failed, setFailed] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const recent = useMemo(
    () => conversations.slice(-TASK_CONVERSATIONS).map((c) => c.conversationId),
    [conversations],
  );
  // A retry of the failed reads, for the conversations it was asked for (new ones read afresh).
  const [attempt, setAttempt] = useState<{ of: string[]; ids: string[] } | undefined>();
  const sequence = useRef(0);
  useEffect(() => {
    const current = ++sequence.current;
    const ids = attempt?.of === recent ? attempt.ids : recent;
    setLoading(true);
    void Promise.all(
      ids.map((id) =>
        client.listTasks(id).then(
          (list) => ({ id, list }),
          () => ({ id, list: undefined }),
        ),
      ),
    ).then((results) => {
      if (current !== sequence.current) return;
      setRead((before) => {
        const after = { ...before };
        for (const { id, list } of results) if (list) after[id] = list;
        return after;
      });
      setFailed(results.filter((r) => !r.list).map((r) => r.id));
      setLoading(false);
    });
    return () => {
      sequence.current++;
    };
  }, [client, recent, attempt]);
  const tasks = recent.flatMap((conversationId) =>
    (read[conversationId] ?? []).map((task) => ({ conversationId, task })),
  );

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const show = (conversationId: string) => {
    open(conversationId);
    router.dismissTo('/chat');
  };
  const words = fold(query.trim());
  const titleOf = (title: string | null | undefined) =>
    title ? displayText(title) : say('common.untitled');
  const conversationHits = words
    ? [...conversations].reverse().filter((c) => fold(titleOf(c.title)).includes(words))
    : [];
  const taskHits = words
    ? tasks.filter(({ task }) =>
        fold(`${task.title ?? ''}\n${task.manifest?.summary ?? ''}`).includes(words),
      )
    : [];

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 14 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Field
              label={say('search.field')}
              id="Search"
              placeholder={say('search.field')}
              value={query}
              onChangeText={setQuery}
              autoFocus
              autoCorrect={false}
              returnKeyType="search"
            />
          </View>
          <PillButton label={say('common.close')} id="Close search" compact onPress={close} />
        </View>
        {!words && <T kind="muted">{say('search.hint')}</T>}
        {words !== '' &&
          !loading &&
          failed.length === 0 &&
          conversationHits.length === 0 &&
          taskHits.length === 0 && (
            <T kind="muted">{say('search.none', { query: query.trim() })}</T>
          )}
        {words !== '' && loading && <T kind="muted">{say('common.loading')}</T>}
        {!loading && failed.length > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T kind="error" style={{ flex: 1 }}>
              {say('search.incomplete')}
            </T>
            <QuietButton
              label={say('common.tryAgain')}
              onPress={() => setAttempt({ of: recent, ids: failed })}
            />
          </View>
        )}
        {conversationHits.length > 0 && (
          <Card label={say('search.conversations')}>
            <T kind="heading">{say('search.conversations')}</T>
            {conversationHits.map((c) => (
              <Result
                key={c.conversationId}
                title={titleOf(c.title)}
                onPress={() => show(c.conversationId)}
              />
            ))}
          </Card>
        )}
        {taskHits.length > 0 && (
          <Card label={say('search.tasks')}>
            <T kind="heading">{say('search.tasks')}</T>
            {taskHits.map(({ conversationId, task }) => (
              <Result
                key={task.taskId}
                title={task.title ? displayText(task.title) : say('task.title')}
                detail={task.manifest ? displayText(task.manifest.summary) : undefined}
                tone={TONE[task.state as keyof typeof TONE] ?? 'attention'}
                onPress={() => show(conversationId)}
              />
            ))}
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}

function Result({
  title,
  detail,
  tone,
  onPress,
}: {
  title: string;
  detail?: string | undefined;
  tone?: 'ok' | 'bad' | 'idle' | 'attention';
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: TOUCH,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {tone && <StatusMark tone={tone} />}
      <View style={{ flex: 1 }}>
        <T kind="body" numberOfLines={1}>
          {title}
        </T>
        {detail ? (
          <T kind="small" numberOfLines={1}>
            {detail}
          </T>
        ) : null}
      </View>
    </Pressable>
  );
}
