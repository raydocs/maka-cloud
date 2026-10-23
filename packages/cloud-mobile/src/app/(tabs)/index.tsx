import {
  BRAND,
  type Conversation,
  ConversationStarter,
  displayText,
  doneSince,
  dollars,
  errorText,
  HomeFeed,
  nextRuns,
  recentConversations,
  relativeTime,
  verbOf,
} from '@maka-cloud/client';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { DecisionCard } from '@/components/Decision';
import { InboxStatus } from '@/components/InboxStatus';
import { HEADER_SPACE } from '@/components/TopBar';
import {
  Card,
  Chip,
  Field,
  RoundButton,
  Screen,
  StatusMark,
  T,
  Tile,
  Tiles,
} from '@/components/ui';
import { useWorkspace } from '@/lib/session';
import { mono } from '@/lib/theme';

/** What a first visit can start with; one tap puts it in the box, the person sends it. */
const EXAMPLES = [
  'Fix the failing test on my main branch',
  'Review my latest open pull request',
  'Add a README section that explains setup',
] as const;

/**
 * Home: first what waits on the person (one-tap cards), then the start sentence, then what was done
 * since they were last here and what runs next. Each part fills in as its data arrives and stays out
 * of the way when the server has nothing, or no such feature.
 */
export default function Home() {
  const { client, conversations, visits, started, open } = useWorkspace();
  const router = useRouter();
  const starter = useMemo(() => new ConversationStarter(client), [client]);
  const feed = useMemo(() => new HomeFeed(client, visits), [client, visits]);
  const { items, busy, inboxLoaded, inboxFailed, answerError, since, done, projects } =
    useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const latest = useRef(conversations);
  latest.current = conversations;
  useEffect(() => {
    feed.start(latest.current);
    // Coming back to the app reads decisions, results and schedule again; going away is a visit.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') feed.refresh();
      else feed.leave();
    });
    return () => {
      subscription.remove();
      feed.stop();
    };
  }, [feed]);
  useEffect(() => feed.conversationsChanged(conversations), [feed, conversations]);
  // Coming back to this tab (not only to the app) reads decisions and results again; the first
  // focus is the load that `start` already began.
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) firstFocus.current = false;
      else feed.refresh();
    }, [feed]),
  );

  const [draft, setDraft] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');

  const now = Date.now();
  const waiting = Object.values(items)
    .filter((item) => item.state !== 'closed')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const finished = since === undefined || done === undefined ? [] : doneSince(done, since);
  const spent = finished.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  const anySpend = finished.some((entry) => entry.costUsd !== undefined);
  const schedule = projects === undefined ? undefined : nextRuns(projects, now);
  const titleOf = (conversationId: string) =>
    displayText(
      conversations.find((c) => c.conversationId === conversationId)?.title ??
        'Untitled conversation',
    );
  const openConversation = (conversationId: string) => {
    open(conversationId);
    router.navigate('/chat');
  };
  const begin = () => {
    if (!draft.trim() || starting) return;
    setStarting(true);
    setStartError('');
    starter.start(draft).then(
      (conversation: Conversation) => {
        started(conversation);
        setDraft('');
        setStarting(false);
        router.navigate('/chat');
      },
      (failure: unknown) => {
        setStartError(errorText(failure));
        setStarting(false);
      },
    );
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          // The page starts under the floating section pill and scrolls on beneath it.
          contentContainerStyle={{ padding: 16, paddingTop: HEADER_SPACE + 4, gap: 14 }}
          scrollIndicatorInsets={{ top: HEADER_SPACE }}
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
        >
          {waiting.length > 0 && (
            <Card label="Decisions waiting">
              <T kind="heading">Waiting on you ({waiting.length})</T>
              {waiting.map((item) => (
                <View key={item.itemId} style={{ gap: 8 }}>
                  <Chip>{verbOf(item.kind)}</Chip>
                  <DecisionCard
                    item={item}
                    disabled={busy}
                    onAnswer={(optionId, text) => void feed.answer(item, optionId, text)}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open conversation: ${titleOf(item.conversationId)}`}
                    onPress={() => openConversation(item.conversationId)}
                    style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-end' }}
                  >
                    <T kind="muted" style={{ textDecorationLine: 'underline' }}>
                      Open conversation
                    </T>
                  </Pressable>
                </View>
              ))}
              {answerError ? <T kind="error">{answerError}</T> : null}
            </Card>
          )}

          {waiting.length === 0 && (
            <InboxStatus loaded={inboxLoaded} failed={inboxFailed} onRetry={() => feed.refresh()} />
          )}

          <Card label="Start something">
            <T kind={waiting.length > 0 ? 'heading' : 'title'}>Make room for your next idea.</T>
            <T kind="muted">
              Tell {BRAND.name} what you’d like done, in a sentence. It takes it from there.
            </T>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
              <View style={{ flex: 1 }}>
                <Field
                  label="What would you like to get done?"
                  placeholder="What would you like to get done?"
                  multiline
                  maxLength={16000}
                  value={draft}
                  onChangeText={(text) => {
                    setDraft(displayText(text));
                    starter.draftEdited();
                  }}
                />
              </View>
              <RoundButton
                label={starting ? 'Starting…' : 'Start'}
                icon="send"
                disabled={starting || !draft.trim()}
                onPress={begin}
              />
            </View>
            {startError ? <T kind="error">{startError}</T> : null}
          </Card>

          {conversations.length === 0 && waiting.length === 0 && (
            <Card label="Ideas to start with">
              <T kind="heading">Not sure where to begin?</T>
              <Tiles>
                {EXAMPLES.map((example) => (
                  <Tile
                    key={example}
                    title={example}
                    onPress={() => {
                      setDraft(example);
                      starter.draftEdited();
                    }}
                  />
                ))}
              </Tiles>
            </Card>
          )}

          {since !== undefined && done !== undefined && finished.length > 0 && (
            <Card label="Since you were last here">
              <T kind="heading">Since you were last here</T>
              <Tiles>
                <Stat label="Done" value={String(finished.length)} />
                <Stat label="Spent" value={anySpend ? dollars(spent) : '—'} />
              </Tiles>
              {!anySpend && finished.length > 0 && <T kind="small">Spend not reported.</T>}
              {finished.map((entry) => (
                <Pressable
                  key={entry.taskId}
                  accessibilityRole="button"
                  onPress={() => openConversation(entry.conversationId)}
                  style={{
                    flexDirection: 'row',
                    gap: 10,
                    alignItems: 'flex-start',
                    minHeight: 44,
                  }}
                >
                  <View style={{ paddingTop: 6 }}>
                    <StatusMark tone={entry.state === 'succeeded' ? 'ok' : 'bad'} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <T kind="body" style={{ fontWeight: '600' }}>
                      {displayText(entry.title)}
                    </T>
                    <T kind="muted">{displayText(entry.outcome)}</T>
                  </View>
                  {entry.costUsd !== undefined && (
                    <T kind="muted" style={mono}>
                      {dollars(entry.costUsd)}
                    </T>
                  )}
                </Pressable>
              ))}
            </Card>
          )}

          {schedule && (schedule.scheduled.length > 0 || schedule.watching > 0) && (
            <Card label="What runs next">
              <T kind="heading">What runs next</T>
              {schedule.scheduled.map((run) => (
                <View key={run.dutyId} style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <T kind="body" style={{ fontWeight: '600' }}>
                      {displayText(run.name)}
                    </T>
                    <T kind="muted">{displayText(run.repo)}</T>
                  </View>
                  <T kind="muted">{relativeTime(run.at, now)}</T>
                </View>
              ))}
              {schedule.watching > 0 && (
                <T kind="muted">
                  {schedule.watching === 1
                    ? '1 more duty wakes when something happens on GitHub.'
                    : `${schedule.watching} more duties wake when something happens on GitHub.`}
                </T>
              )}
            </Card>
          )}

          {conversations.length > 0 && (
            <Card label="Recent conversations">
              <T kind="heading">Pick up where you left off</T>
              <Tiles>
                {recentConversations(conversations).map((c) => (
                  <Tile
                    key={c.conversationId}
                    over={startedOn(c.createdAt)}
                    title={displayText(c.title ?? 'Untitled conversation')}
                    onPress={() => openConversation(c.conversationId)}
                  />
                ))}
              </Tiles>
            </Card>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** The day a conversation began, short ("Oct 16"), in the phone's own language. */
function startedOn(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Tile
      over={label}
      title={value}
      titleStyle={/\d/u.test(value) ? [{ fontSize: 24, lineHeight: 30 }, mono] : undefined}
      accessibilityLabel={`${label}: ${value}`}
    />
  );
}
