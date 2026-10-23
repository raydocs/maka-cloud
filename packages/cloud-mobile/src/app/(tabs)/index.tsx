import {
  type Conversation,
  ConversationStarter,
  displayText,
  dollars,
  errorText,
  HomeFeed,
  relativeTime,
  verbOf,
} from '@maka-cloud/client';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Pressable, ScrollView, View } from 'react-native';
import { Composer, Dock, TopFade, useConversationSheet } from '@/components/Composer';
import { DecisionCard } from '@/components/Decision';
import { InboxStatus } from '@/components/InboxStatus';

import {
  ButtonRow,
  Card,
  Chip,
  PillButton,
  Screen,
  StatusMark,
  T,
  Thinking,
  TOP_BAR,
} from '@/components/ui';
import { type Language, useT } from '@/lib/i18n';
import { useWorkspace } from '@/lib/session';
import { partOfDay, type SinceRow, todayOf, type WorkingRow } from '@/lib/today';

/** What a quiet day can start with; one tap puts it in the box, the person sends it. */
const IDEAS = ['home.idea.1', 'home.idea.2', 'home.idea.3'] as const;

/**
 * Home is the day's page, built from the cards the server keeps for this person (`/v1/home`), in a
 * fixed order: the date and a greeting, what needs the person (the only place for the attention
 * colour), what is working now, what happened since the last visit, what runs next, and on a quiet
 * day three ideas. A part with nothing in it is left out. Starting work is the composer's job.
 * Leaving Home (another section, or the app going to the background) tells the server which cards
 * were shown, once per visit.
 */
export default function Home() {
  const { client, conversations, visits, started, open } = useWorkspace();
  const router = useRouter();
  const { t: say, tx, lang } = useT();
  const starter = useMemo(() => new ConversationStarter(client), [client]);
  const feed = useMemo(() => new HomeFeed(client, visits), [client, visits]);
  const snapshot = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const { busy, inboxLoaded, inboxFailed, answerError } = snapshot;
  const now = Date.now();
  const today = todayOf(snapshot, conversations, now);

  // The cards on the screen right now: the ones the server is told about when the person leaves.
  const shown = useRef<string[]>([]);
  shown.current = today.shown;
  const focused = useRef(false);
  const latest = useRef(conversations);
  latest.current = conversations;
  useEffect(() => {
    feed.start(latest.current);
    // Back in the app on Home reads it again; going to the background from Home is leaving it. An
    // `inactive` blip (a system sheet, the app switcher on its way) is not.
    const subscription = AppState.addEventListener('change', (next) => {
      if (!focused.current) return;
      if (next === 'active') feed.refresh();
      else if (next === 'background') feed.leave(shown.current);
    });
    return () => {
      subscription.remove();
      feed.stop(shown.current);
    };
  }, [feed]);
  useEffect(() => feed.conversationsChanged(conversations), [feed, conversations]);
  // Coming back to this section reads Home again (the first focus is the load `start` began);
  // going to another section is leaving Home.
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      if (firstFocus.current) firstFocus.current = false;
      else feed.refresh();
      return () => {
        focused.current = false;
        feed.leave(shown.current);
      };
    }, [feed]),
  );

  const [draft, setDraft] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [dock, setDock] = useState(76);
  const { openSheet, sheet } = useConversationSheet(() => router.navigate('/chat'));

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

  const { needs, working, since, next, watching } = today;
  const quiet = needs.length === 0 && working.length === 0 && since.length === 0;
  const firstVisit = conversations.length === 0;
  // Until the decisions are read (or when they could not be), the page does not say nothing needs
  // the person. A first visit's line and the ideas wait only for the read to settle.
  const known = inboxLoaded && !inboxFailed;
  const settled = inboxLoaded || inboxFailed;

  return (
    <Screen>
      <View style={{ flex: 1 }}>
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
          <View style={{ gap: 2, paddingHorizontal: 4 }}>
            <T kind="small" testID="home-date">
              {dateOf(now, lang)}
            </T>
            <T kind="title" testID="home-today-title">
              {say(`home.greeting.${partOfDay(now)}`)}
            </T>
            {quiet && firstVisit && settled && <T kind="muted">{say('home.empty')}</T>}
            {quiet && !firstVisit && known && <T kind="muted">{say('home.quiet')}</T>}
            {startError ? <T kind="error">{tx(startError)}</T> : null}
          </View>

          {needs.length > 0 && (
            <Card label={say('home.waiting.label')}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <StatusMark tone="attention" />
                <T kind="heading" testID={`home-waiting-${needs.length}`}>
                  {say('home.waiting', { count: needs.length })}
                </T>
              </View>
              {needs.map((item) => (
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

          {/* Where the decisions would be: bars while they are read, a retry when they could not be. */}
          {needs.length === 0 && !known && (
            <InboxStatus loaded={inboxLoaded} failed={inboxFailed} onRetry={() => feed.refresh()} />
          )}

          {working.length > 0 && (
            <Card label={say('home.working')}>
              <T kind="heading" testID="home-working">
                {say('home.working')}
              </T>
              {working.map((row) => (
                <Working
                  key={row.task.taskId}
                  row={row}
                  title={row.task.title ? displayText(row.task.title) : titleOf(row.conversationId)}
                  onOpen={() => openConversation(row.conversationId)}
                />
              ))}
            </Card>
          )}

          {since.length > 0 && (
            <Card label={say('home.since')}>
              <T kind="heading" testID="home-since">
                {say('home.since')}
              </T>
              {since.map((row) => (
                <Since key={row.key} row={row} onOpen={openConversation} />
              ))}
            </Card>
          )}

          {(next.length > 0 || watching > 0) && (
            <Card label={say('home.next')}>
              <T kind="heading">{say('home.next')}</T>
              {next.map((run) => (
                <View key={run.dutyId} style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <T kind="body">{displayText(run.name)}</T>
                    <T kind="muted">{displayText(run.repo)}</T>
                  </View>
                  <T kind="muted">{tx(relativeTime(run.at, now))}</T>
                </View>
              ))}
              {watching > 0 && (
                <T kind="muted">
                  {watching === 1
                    ? say('home.watching.one')
                    : say('home.watching.many', { count: watching })}
                </T>
              )}
            </Card>
          )}

          {quiet && settled && (
            <View
              style={{ gap: 10, paddingHorizontal: 4 }}
              accessibilityLabel={say('home.ideas.label')}
            >
              <T kind="heading">{say('home.ideas.title')}</T>
              <ButtonRow>
                {IDEAS.map((idea) => (
                  <PillButton
                    key={idea}
                    label={say(idea)}
                    id={idea}
                    compact
                    // While a conversation starts, the draft is what is being sent.
                    disabled={starting}
                    onPress={() => {
                      setDraft(say(idea));
                      starter.draftEdited();
                    }}
                  />
                ))}
              </ButtonRow>
            </View>
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
      </View>
    </Screen>
  );
}

/** Today's date in the app's language: "Friday, October 23", "10月23日星期五". */
function dateOf(at: number, lang: Language): string {
  return new Date(at).toLocaleDateString(lang, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/** A task at work: its mark, its title, its latest narration when there is one, and when it began. */
function Working({ row, title, onOpen }: { row: WorkingRow; title: string; onOpen: () => void }) {
  const { t: say, lang } = useT();
  const { task } = row;
  const at = task.startedAt
    ? new Date(task.startedAt).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
    : undefined;
  const state =
    task.state === 'queued'
      ? say('home.working.queued')
      : task.state === 'paused'
        ? say('home.working.paused')
        : undefined;
  const meta = [state, at ? say('home.working.started', { time: at }) : undefined].filter(
    (part): part is string => part !== undefined,
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={say('home.openLabel', { title })}
      onPress={onOpen}
      style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', minHeight: 44 }}
    >
      <View style={{ paddingTop: 6 }}>
        {task.state === 'running' ? <Thinking /> : <StatusMark tone="idle" />}
      </View>
      <View style={{ flex: 1 }}>
        <T kind="body">{title}</T>
        {task.narration ? <T kind="muted">{displayText(task.narration)}</T> : null}
        {meta.length > 0 && (
          <T kind="small" style={{ fontVariant: ['tabular-nums'] }}>
            {meta.join(' · ')}
          </T>
        )}
      </View>
    </Pressable>
  );
}

/** One thing that happened since the last visit: a task that ended, or a note in the server's words. */
function Since({ row, onOpen }: { row: SinceRow; onOpen: (conversationId: string) => void }) {
  const { t: say, tx } = useT();
  if (row.kind === 'note')
    return (
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        <View style={{ paddingTop: 6 }}>
          <StatusMark tone="idle" />
        </View>
        <T kind="body" style={{ flex: 1 }}>
          {displayText(row.text)}
        </T>
      </View>
    );
  const title = row.title ?? say('task.title');
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onOpen(row.conversationId)}
      style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', minHeight: 44 }}
    >
      <View style={{ paddingTop: 6 }}>
        <StatusMark tone={row.tone} />
      </View>
      <View style={{ flex: 1 }}>
        <T kind="body">{title}</T>
        {/* A finished task's summary is its own words; any other outcome is the app's. */}
        <T kind="muted">{row.ownWords ? displayText(row.outcome) : tx(displayText(row.outcome))}</T>
      </View>
      {/* A spend shows only when the server reported one; there is no "not reported" line. */}
      {row.costUsd !== undefined && (
        <View
          accessible
          accessibilityLabel={say('common.labelValue', {
            label: say('task.cost'),
            value: dollars(row.costUsd),
          })}
        >
          <T kind="muted" style={{ fontVariant: ['tabular-nums'] }}>
            {dollars(row.costUsd)}
          </T>
        </View>
      )}
    </Pressable>
  );
}
