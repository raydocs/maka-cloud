import {
  BRAND,
  type Conversation,
  ConversationFeed,
  type ConversationState,
  ConversationStarter,
  conversationSummary,
  displayText,
  dollars,
  errorText,
  TERMINAL,
  type TaskControl,
  type TaskView,
  totalCost,
} from '@maka-cloud/client';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AppState,
  FlatList,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  ScrollView,
  View,
} from 'react-native';
import { Composer, Dock, TopFade, useConversationSheet } from '@/components/Composer';
import { DecisionCard, QuestionBlock } from '@/components/Decision';
import { TaskDelivery } from '@/components/Delivery';
import { TaskDetails } from '@/components/TaskDetails';
import { TaskRow } from '@/components/TaskRow';
import {
  Appear,
  ButtonRow,
  Card,
  PillButton,
  Rich,
  Screen,
  Shimmer,
  StatusMark,
  T,
  Thinking,
  TOP_BAR,
  withoutMarks,
} from '@/components/ui';
import { useT } from '@/lib/i18n';
import { keepLive } from '@/lib/live';
import { useWorkspace } from '@/lib/session';
import { mono, radius, useTheme } from '@/lib/theme';

type Message = ConversationState['messages'][number];

/** What an empty chat offers to start with; a tap puts it in the box, the person sends it. */
const IDEAS = ['home.idea.1', 'home.idea.2', 'home.idea.3'] as const;

/**
 * Chat, in the person's own appearance (light by day, dark at night) like every section. The
 * conversation scrolls under the floating top bar and the composer.
 */
export default function Chat() {
  const { conversations, chosen } = useWorkspace();
  const selected = conversations.find((c) => c.conversationId === chosen);
  return (
    <Screen>
      {selected ? (
        <ConversationScreen
          key={selected.conversationId}
          conversationId={selected.conversationId}
        />
      ) : (
        <NewConversation />
      )}
    </Screen>
  );
}

/** An opening line and three ideas: what an empty chat says before anything has been said. */
function Opening({ onIdea, busy }: { onIdea: (words: string) => void; busy: boolean }) {
  const { t: say } = useT();
  return (
    <View style={{ gap: 12 }} accessibilityLabel={say('home.ideas.label')}>
      <T kind="heading">{say('chat.empty.title')}</T>
      <T kind="muted">{say('chat.empty.body', { name: BRAND.name })}</T>
      <ButtonRow>
        {IDEAS.map((idea) => (
          <PillButton
            key={idea}
            label={say(idea)}
            id={idea}
            compact
            disabled={busy}
            onPress={() => onIdea(say(idea))}
          />
        ))}
      </ButtonRow>
    </View>
  );
}

/** The Chat tab with no conversation open: it can still be talked to; the first message starts one. */
function NewConversation() {
  const { client, conversations, started } = useWorkspace();
  const { tx } = useT();
  const starter = useMemo(() => new ConversationStarter(client), [client]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState('');
  const [dock, setDock] = useState(76);
  const { openSheet, sheet } = useConversationSheet();
  const send = () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    setFailure('');
    starter.start(draft).then(
      (conversation: Conversation) => {
        setSending(false);
        setDraft('');
        started(conversation);
      },
      (error: unknown) => {
        setFailure(errorText(error));
        setSending(false);
      },
    );
  };
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      {/* Scrolls, so large text or the keyboard never hides the ideas or a failure under the
          composer. */}
      <ScrollView
        testID="new-conversation"
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: 20,
          paddingTop: TOP_BAR + 16,
          paddingBottom: dock + 16,
          gap: 12,
        }}
        scrollIndicatorInsets={{ top: TOP_BAR, bottom: dock }}
        keyboardShouldPersistTaps="handled"
      >
        <Opening
          // While the conversation starts, the draft is what is being sent.
          busy={sending}
          onIdea={(words) => {
            setDraft(words);
            starter.draftEdited();
          }}
        />
        {failure ? <T kind="error">{tx(failure)}</T> : null}
      </ScrollView>
      <Dock height={dock} onHeight={setDock}>
        <Composer
          draft={draft}
          onDraft={(text) => {
            setDraft(text);
            starter.draftEdited();
          }}
          sending={sending}
          disabled={sending}
          onSend={send}
          {...(conversations.length > 0 ? { onPlus: openSheet } : {})}
        />
      </Dock>
      {sheet}
    </KeyboardAvoidingView>
  );
}

/**
 * Which items arrived after the screen first showed what it had: only those spring into place.
 * The first batch (the history) is just there.
 */
function useArrivals(ids: readonly string[], ready: boolean): (id: string) => boolean {
  const first = useRef<Set<string> | null>(null);
  if (first.current === null && ready) first.current = new Set(ids);
  return (id) => first.current !== null && !first.current.has(id);
}

function ConversationScreen({ conversationId }: { conversationId: string }) {
  const { client, conversations } = useWorkspace();
  const theme = useTheme();
  const { t: say, tx } = useT();
  /** The floating composer's height: the list scrolls on under it, by this much more. */
  const [dock, setDock] = useState(76);
  const conversation = conversations.find((c) => c.conversationId === conversationId);
  const feed = useMemo(
    () => new ConversationFeed(client, conversationId),
    [client, conversationId],
  );
  // The stream runs only while this tab is in front and the app is in the foreground.
  useFocusEffect(useCallback(() => keepLive(feed, AppState), [feed]));
  const snapshot = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const { state, status, error, busy, noPause } = snapshot;
  const { tasks, questions, running, openQuestions } = conversationSummary(snapshot);
  const total = totalCost(tasks);
  const [draft, setDraft] = useState('');
  const [detail, setDetail] = useState<TaskView | undefined>();
  const { openSheet, sheet } = useConversationSheet();
  const scroll = useRef<FlatList<Message> | null>(null);
  /** The newest messages stay in view only while the person is already reading them. */
  const atEnd = useRef(true);
  // Only the person's own scrolling decides this; a scroll the list makes while measuring does not.
  const trackEnd = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = nativeEvent;
    atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
  };
  const roots = tasks.filter((task) => !task.parentTaskId || !state.tasks[task.parentTaskId]);
  const inbox = Object.values(state.inbox);
  // As on the web: a finished task whose row already shows its outcome is not announced again here;
  // its card waits on Home.
  const shown = new Set(roots.filter((task) => task.manifest).map((task) => task.taskId));
  const waiting = inbox.filter(
    (item) =>
      item.state !== 'closed' &&
      !(item.kind === 'finished' && item.taskId !== null && shown.has(item.taskId)),
  );
  // Something that waits on the person is always brought into view.
  const needsYou = openQuestions.size + waiting.length;
  useEffect(() => {
    if (needsYou > 0) {
      atEnd.current = true;
      scroll.current?.scrollToEnd({ animated: true });
    }
  }, [needsYou]);
  // The employee is at work while a task runs, or while the person's last message has no reply yet;
  // a question or decision waiting on them is not work.
  const working =
    openQuestions.size === 0 &&
    waiting.length === 0 &&
    (tasks.some((task) => !TERMINAL.has(task.state) && task.state !== 'paused') ||
      state.messages.at(-1)?.role === 'user');
  // Messages and cards that arrive while the chat is open rise into place; the history does not.
  const arrived = useArrivals(
    [
      ...state.messages.map((message) => message.id),
      ...roots.map((task) => `task-${task.taskId}-${task.state}`),
      ...questions.map((question) => question.questionId),
      ...waiting.map((item) => item.itemId),
    ],
    status === 'Live' || state.messages.length > 0,
  );
  const send = () => {
    const sending = draft;
    // Words typed while it was sending stay in the box.
    void feed.send(sending).then((sent) => sent && setDraft((now) => (now === sending ? '' : now)));
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <View style={{ flex: 1 }}>
        <FlatList
          ref={scroll}
          data={state.messages}
          keyExtractor={(message) => message.id}
          initialNumToRender={20}
          windowSize={7}
          onContentSizeChange={() =>
            atEnd.current && scroll.current?.scrollToEnd({ animated: false })
          }
          onScrollEndDrag={trackEnd}
          onMomentumScrollEnd={trackEnd}
          // The list runs on under the top bar and the composer, which float over fades.
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: TOP_BAR + 16,
            paddingBottom: dock + 16,
          }}
          scrollIndicatorInsets={{ top: TOP_BAR, bottom: dock }}
          keyboardShouldPersistTaps="handled"
          accessibilityLabel={say('chat.messages')}
          ListHeaderComponent={
            <T kind="heading" numberOfLines={2} style={{ marginBottom: 14 }}>
              {conversation?.title ? displayText(conversation.title) : say('chat.freshStart')}
            </T>
          }
          ListEmptyComponent={
            <Opening
              busy={busy === 'message'}
              onIdea={(words) => {
                setDraft(words);
                feed.draftEdited();
              }}
            />
          }
          renderItem={({ item: message }) => (
            <Appear enter={arrived(message.id)}>
              {/* Who said it is plain from the side it sits on; a screen reader still hears the name. */}
              <View
                accessible
                accessibilityLabel={say('chat.said', {
                  who:
                    message.role === 'user'
                      ? say('chat.you')
                      : message.role === 'notice'
                        ? say('chat.update')
                        : BRAND.name,
                  text: withoutMarks(displayText(message.text)),
                })}
                style={[
                  { gap: 2, marginBottom: 18 },
                  message.role === 'user'
                    ? {
                        alignSelf: 'flex-end',
                        maxWidth: '85%',
                        backgroundColor: theme.chip,
                        borderRadius: radius.card,
                        paddingHorizontal: 16,
                        paddingVertical: 10,
                      }
                    : { alignSelf: 'stretch' },
                ]}
              >
                <Rich text={displayText(message.text)} />
              </View>
            </Appear>
          )}
          ListFooterComponent={
            <View style={{ gap: 14 }}>
              {working && (
                <View
                  accessible
                  accessibilityRole="text"
                  accessibilityLabel={say('chat.workingLabel', { name: BRAND.name })}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                >
                  <Thinking />
                  <Shimmer>
                    <T kind="muted">{say('chat.working', { name: BRAND.name })}</T>
                  </Shimmer>
                </View>
              )}
              {roots.length > 0 && (
                <Card label={say('chat.running.label')}>
                  {/* Only what is known: no "0 running" once all is done, no cost the server never sent. */}
                  {(running > 0 || total.usd !== undefined) && (
                    <T kind="small">
                      {running > 0 && say('chat.running', { count: running })}
                      {running > 0 && total.usd !== undefined && ' · '}
                      {total.usd !== undefined && say('chat.totalCost')}
                      {total.usd !== undefined && (
                        <T kind="small" style={mono}>
                          {dollars(total.usd)}
                        </T>
                      )}
                      {total.usd !== undefined && !total.complete && say('chat.notAllReported')}
                    </T>
                  )}
                  {roots.map((task) => (
                    <TaskRow
                      key={task.taskId}
                      task={task}
                      tasks={tasks}
                      noPause={noPause}
                      busy={Boolean(busy)}
                      resultCard
                      onControl={(taskId: string, action: TaskControl) =>
                        void feed.act(`${action}-${taskId}`, () => feed.control(taskId, action))
                      }
                    />
                  ))}
                </Card>
              )}
              {roots.map((task) => (
                <Appear key={task.taskId} enter={arrived(`task-${task.taskId}-${task.state}`)}>
                  <TaskDelivery
                    client={client}
                    task={task}
                    listings={snapshot.artifacts[task.taskId]?.listings ?? []}
                    onOpenTask={setDetail}
                  />
                </Appear>
              ))}
              {questions.map((question) => (
                <Appear key={question.questionId} enter={arrived(question.questionId)}>
                  <Card label={say('chat.decision.label')}>
                    <QuestionBlock
                      question={question}
                      answered={state.answers[question.questionId]}
                      disabled={Boolean(busy)}
                      onAnswer={(optionId, text) =>
                        void feed.answerQuestion(question, optionId, text)
                      }
                    />
                  </Card>
                </Appear>
              ))}
              {waiting
                .filter((item) => !openQuestions.has(displayText(item.ask).trim()))
                .map((item) => (
                  <Appear key={item.itemId} enter={arrived(item.itemId)}>
                    <Card label={say('chat.needsYou.label')}>
                      <DecisionCard
                        item={item}
                        disabled={Boolean(busy)}
                        onAnswer={(optionId, text) => void feed.answerItem(item, optionId, text)}
                      />
                    </Card>
                  </Appear>
                ))}
              {error ? <T kind="error">{tx(error)}</T> : null}
            </View>
          }
        />
        <TopFade />
        <Dock height={dock} onHeight={setDock}>
          {/* Nothing to say while connected; only a dropped connection is worth a glance. */}
          {status !== 'Live' && (
            <View
              accessible
              accessibilityRole="text"
              accessibilityLabel={tx(status)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center' }}
            >
              {status !== 'Connecting…' && <StatusMark tone="attention" />}
              <T kind="small">{tx(status)}</T>
            </View>
          )}
          <Composer
            draft={draft}
            onDraft={(text) => {
              setDraft(text);
              feed.draftEdited();
            }}
            sending={busy === 'message'}
            disabled={Boolean(busy)}
            onSend={send}
            onPlus={openSheet}
          />
        </Dock>
      </View>
      {detail && (
        <TaskDetails
          client={client}
          task={state.tasks[detail.taskId] ?? detail}
          onClose={() => setDetail(undefined)}
        />
      )}
      {sheet}
    </KeyboardAvoidingView>
  );
}
