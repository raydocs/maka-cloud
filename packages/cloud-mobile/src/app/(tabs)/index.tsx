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
import { Composer, Dock, TopFade, useConversationSheet } from '@/components/Composer';
import { DecisionCard } from '@/components/Decision';
import { InboxStatus } from '@/components/InboxStatus';

import { Card, Chip, Screen, StatusMark, T, Tile, Tiles, TOP_BAR } from '@/components/ui';
import { type Language, useT } from '@/lib/i18n';
import { useWorkspace } from '@/lib/session';
import { mono } from '@/lib/theme';

/** What a first visit can start with; one tap puts it in the box, the person sends it. */
const EXAMPLES = ['home.idea.1', 'home.idea.2', 'home.idea.3'] as const;

/**
 * Home: first what waits on the person (one-tap cards), then the start sentence, then what was done
 * since they were last here and what runs next. Each part fills in as its data arrives and stays out
 * of the way when the server has nothing, or no such feature.
 */
export default function Home() {
  const { client, conversations, visits, started, open } = useWorkspace();
  const router = useRouter();
  const { t: say, tx, lang } = useT();
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
  const [dock, setDock] = useState(76);
  const { openSheet, sheet } = useConversationSheet(() => router.navigate('/chat'));

  const now = Date.now();
  const waiting = Object.values(items)
    .filter((item) => item.state !== 'closed')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const finished = since === undefined || done === undefined ? [] : doneSince(done, since);
  const spent = finished.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  const anySpend = finished.some((entry) => entry.costUsd !== undefined);
  const schedule = projects === undefined ? undefined : nextRuns(projects, now);
  const titleOf = (conversationId: string) => {
    const title = conversations.find((c) => c.conversationId === conversationId)?.title;
    return title ? displayText(title) : say('common.untitled');
  };
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
          contentContainerStyle={{
            padding: 16,
            paddingTop: TOP_BAR + 12,
            paddingBottom: dock + 16,
            gap: 14,
          }}
          scrollIndicatorInsets={{ top: TOP_BAR, bottom: dock }}
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
        >
          {waiting.length > 0 && (
            <Card label={say('home.waiting.label')}>
              <T kind="heading" testID={`home-waiting-${waiting.length}`}>
                {say('home.waiting', { count: waiting.length })}
              </T>
              {waiting.map((item) => (
                <View key={item.itemId} style={{ gap: 8 }}>
                  <Chip>{tx(verbOf(item.kind))}</Chip>
                  <DecisionCard
                    item={item}
                    disabled={busy}
                    onAnswer={(optionId, text) => void feed.answer(item, optionId, text)}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={say('home.openLabel', {
                      title: titleOf(item.conversationId),
                    })}
                    onPress={() => openConversation(item.conversationId)}
                    style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-end' }}
                  >
                    <T kind="muted" style={{ textDecorationLine: 'underline' }}>
                      {say('home.open')}
                    </T>
                  </Pressable>
                </View>
              ))}
              {answerError ? <T kind="error">{tx(answerError)}</T> : null}
            </Card>
          )}

          {waiting.length === 0 && (
            <InboxStatus loaded={inboxLoaded} failed={inboxFailed} onRetry={() => feed.refresh()} />
          )}

          {/* The start sentence; the box it asks for is the composer at the bottom. */}
          <View style={{ gap: 6, paddingHorizontal: 4 }}>
            <T kind={waiting.length > 0 ? 'heading' : 'title'} testID="home-start-title">
              {say('home.start.title')}
            </T>
            <T kind="muted">{say('home.start.body', { name: BRAND.name })}</T>
            {startError ? <T kind="error">{tx(startError)}</T> : null}
          </View>

          {conversations.length === 0 && waiting.length === 0 && (
            <Card label={say('home.ideas.label')}>
              <T kind="heading">{say('home.ideas.title')}</T>
              <Tiles>
                {EXAMPLES.map((example) => (
                  <Tile
                    key={example}
                    title={say(example)}
                    onPress={() => {
                      setDraft(say(example));
                      starter.draftEdited();
                    }}
                  />
                ))}
              </Tiles>
            </Card>
          )}

          {since !== undefined && done !== undefined && finished.length > 0 && (
            <Card label={say('home.since')}>
              <T kind="heading">{say('home.since')}</T>
              {/* Spend shows only when the server reported some; there is no "not reported" tile. */}
              <Tiles>
                <Stat label={say('home.done')} value={String(finished.length)} />
                {anySpend && <Stat label={say('home.spent')} value={dollars(spent)} />}
              </Tiles>
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
                    <T kind="body">
                      {entry.task.title ? displayText(entry.task.title) : say('task.title')}
                    </T>
                    {/* A finished task's summary is its own words; any other outcome is the app's. */}
                    <T kind="muted">
                      {entry.state === 'succeeded' && entry.task.manifest
                        ? displayText(entry.outcome)
                        : tx(displayText(entry.outcome))}
                    </T>
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
            <Card label={say('home.next')}>
              <T kind="heading">{say('home.next')}</T>
              {schedule.scheduled.map((run) => (
                <View key={run.dutyId} style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <T kind="body">{displayText(run.name)}</T>
                    <T kind="muted">{displayText(run.repo)}</T>
                  </View>
                  <T kind="muted">{tx(relativeTime(run.at, now))}</T>
                </View>
              ))}
              {schedule.watching > 0 && (
                <T kind="muted">
                  {schedule.watching === 1
                    ? say('home.watching.one')
                    : say('home.watching.many', { count: schedule.watching })}
                </T>
              )}
            </Card>
          )}

          {conversations.length > 0 && (
            <Card label={say('home.recent.label')}>
              <T kind="heading">{say('home.recent.title')}</T>
              <Tiles>
                {recentConversations(conversations).map((c) => (
                  <Tile
                    key={c.conversationId}
                    over={startedOn(c.createdAt, lang)}
                    title={c.title ? displayText(c.title) : say('common.untitled')}
                    onPress={() => openConversation(c.conversationId)}
                  />
                ))}
              </Tiles>
            </Card>
          )}
        </ScrollView>
        <TopFade />
        <Dock height={dock} onHeight={setDock}>
          <Composer
            draft={draft}
            onDraft={(text) => {
              setDraft(text);
              starter.draftEdited();
            }}
            sending={starting}
            disabled={starting}
            onSend={begin}
            {...(conversations.length > 0 ? { onPlus: openSheet } : {})}
            fieldId="What would you like to get done?"
            fieldLabel={say('home.start.field')}
            placeholder={say('home.start.field')}
            sendId="Start"
            sendLabel={say('home.start.go')}
            sendingId="Starting…"
            sendingLabel={say('home.start.going')}
          />
        </Dock>
        {sheet}
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** The day a conversation began, short ("Oct 16", "10月16日"), in the app's language. */
function startedOn(at: number, lang: Language): string {
  return new Date(at).toLocaleDateString(lang, { month: 'short', day: 'numeric' });
}

function Stat({ label, value }: { label: string; value: string }) {
  const { t: say } = useT();
  return (
    <Tile
      over={label}
      title={value}
      titleStyle={{ fontSize: 22, lineHeight: 30, fontVariant: ['tabular-nums'] }}
      accessibilityLabel={say('common.labelValue', { label, value })}
    />
  );
}
