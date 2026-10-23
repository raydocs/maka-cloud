import {
  BRAND,
  type Conversation,
  ConversationFeed,
  type ConversationState,
  ConversationStarter,
  conversationSummary,
  displayText,
  type ErrorText,
  errorText,
  TERMINAL,
  type TaskControl,
  type PendingSend,
  type PendingSends,
  reusable,
  type TaskView,
} from '@maka-cloud/client';
import { useFocusEffect } from 'expo-router';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AppState,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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
  QuietButton,
  Rich,
  Screen,
  StatusMark,
  T,
  TOP_BAR,
  withoutMarks,
} from '@/components/ui';
import { TaskPill, WorkBlock } from '@/components/Work';
import { useReduceMotion } from '@/lib/appearance';
import { useT } from '@/lib/i18n';
import { keepLive } from '@/lib/live';
import { useWorkspace } from '@/lib/session';
import { radius, useTheme } from '@/lib/theme';
import { type ChatItem, chatTimeline } from '@/lib/work';

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
  const [failure, setFailure] = useState<ErrorText>('');
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
    <View style={{ flex: 1 }}>
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
    </View>
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

/** One message as the chat shows it: the person's on the right in a bubble, the rest full width. */
function Bubble({
  message,
  status,
  children,
}: {
  message: Message;
  /** Where a message of the person's stands ("Sending…", "Not sent"), heard with it. */
  status?: string;
  children?: ReactNode;
}) {
  const theme = useTheme();
  const { t: say } = useT();
  const said = {
    who:
      message.role === 'user'
        ? say('chat.you')
        : message.role === 'notice'
          ? say('chat.update')
          : BRAND.name,
    text: withoutMarks(displayText(message.text)),
  };
  return (
    // Who said it is plain from the side it sits on; a screen reader still hears the name.
    <View
      accessible
      accessibilityLabel={
        status ? say('chat.saidStatus', { ...said, status }) : say('chat.said', said)
      }
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
      {children}
    </View>
  );
}

/** A message the person sent that the conversation has not shown yet. */
interface Outgoing {
  text: string;
  state: 'sending' | 'sent' | 'failed';
  /**
   * The person's messages the conversation already showed when this one was sent: only a message
   * beyond these can be it. Unknown for a send kept from an earlier visit.
   */
  seen?: ReadonlySet<string>;
}

/**
 * The person's message from the moment they send it, before the conversation shows it: in its
 * place at once, "Sending…" under it, dimmed only if that takes more than two seconds (a fast send
 * never flickers). A send that failed says so, with "Send again" (the same message, so the server
 * runs it once) and "Delete".
 */
function OutgoingBubble({
  outgoing,
  onResend,
  onDiscard,
  busy,
}: {
  outgoing: Outgoing;
  onResend: () => void;
  onDiscard: () => void;
  busy: boolean;
}) {
  const { t: say } = useT();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (outgoing.state !== 'sending') return;
    const timer = setTimeout(() => setSlow(true), 2000);
    return () => clearTimeout(timer);
  }, [outgoing.state]);
  return (
    <View testID="outgoing" style={{ opacity: outgoing.state === 'sending' && slow ? 0.6 : 1 }}>
      <Bubble
        message={{ id: 'outgoing', role: 'user', text: outgoing.text }}
        status={
          outgoing.state === 'sending'
            ? say('chat.sending')
            : outgoing.state === 'failed'
              ? say('chat.notSent')
              : undefined
        }
      >
        {outgoing.state === 'sending' && (
          <T kind="small" testID="outgoing-sending">
            {say('chat.sending')}
          </T>
        )}
      </Bubble>
      {outgoing.state === 'failed' && (
        <View
          testID="outgoing-failed"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            alignSelf: 'flex-end',
            gap: 16,
            marginTop: -12,
            marginBottom: 6,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <StatusMark tone="attention" />
            <T kind="small">{say('chat.notSent')}</T>
          </View>
          <QuietButton
            label={say('chat.resend')}
            id="Send again"
            disabled={busy}
            onPress={onResend}
          />
          <QuietButton
            label={say('chat.discard')}
            id="Delete"
            disabled={busy}
            onPress={onDiscard}
          />
        </View>
      )}
    </View>
  );
}

/**
 * Each conversation's send that the server has not acknowledged, kept by the feed from before it
 * posts until the server answers (`PendingSends`), for as long as the app runs. Coming back to a
 * conversation shows it again with "Send again" and "Delete", and "Send again" reuses its id, so
 * the server runs it once even if it had taken it. A send that finishes after the person left
 * clears itself.
 */
const keptSends = new Map<string, { send: PendingSend; seen?: ReadonlySet<string> }>();
/** The person's messages a conversation showed when its next send started (`Outgoing.seen`). */
const seenAtSend = new Map<string, ReadonlySet<string>>();

/**
 * One feed's view of the kept sends. A feed clears only the send it wrote itself, so a request of
 * an earlier visit that ends late cannot clear a newer send of the same conversation.
 */
function sendsOfFeed(): PendingSends {
  let mine: string | undefined;
  return {
    read: (key) => keptSends.get(key)?.send,
    write: (key, send) => {
      mine = send.id;
      const kept = keptSends.get(key);
      // The same send again keeps the boundary it started with.
      const seen = kept?.send.id === send.id ? kept.seen : seenAtSend.get(key);
      keptSends.set(key, seen ? { send, seen } : { send });
    },
    clear: (key) => {
      if (mine !== undefined && keptSends.get(key)?.send.id === mine) keptSends.delete(key);
    },
  };
}

const quietlyLive = (task: TaskView) => !TERMINAL.has(task.state) && task.state !== 'paused';

function ConversationScreen({ conversationId }: { conversationId: string }) {
  const { client, conversations } = useWorkspace();
  const { t: say, tx } = useT();
  const reduce = useReduceMotion();
  /** The floating composer's height: the list scrolls on under it, by this much more. */
  const [dock, setDock] = useState(76);
  const conversation = conversations.find((c) => c.conversationId === conversationId);
  const feed = useMemo(
    () => new ConversationFeed(client, conversationId, undefined, sendsOfFeed()),
    [client, conversationId],
  );
  // The stream runs only while this tab is in front and the app is in the foreground.
  useFocusEffect(useCallback(() => keepLive(feed, AppState), [feed]));
  const snapshot = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const { state, status, error, busy, noPause } = snapshot;
  const { tasks, questions, openQuestions } = conversationSummary(snapshot);
  const [draft, setDraft] = useState('');
  const [outgoing, setOutgoing] = useState<Outgoing | undefined>(() => {
    const kept = keptSends.get(conversationId);
    if (!kept || !reusable(kept.send, kept.send.text, Date.now())) return undefined;
    return kept.seen
      ? { text: kept.send.text, state: 'failed', seen: kept.seen }
      : { text: kept.send.text, state: 'failed' };
  });
  const [detail, setDetail] = useState<TaskView | undefined>();
  /** The task pills opened to show their row (the step, the cost and the controls). */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const { openSheet, sheet } = useConversationSheet();
  const scroll = useRef<FlatList<ChatItem> | null>(null);
  /** The newest messages stay in view only while the person is already reading them. */
  const atEnd = useRef(true);
  // Only the person's own scrolling decides this; a scroll the list makes while measuring does not.
  const trackEnd = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = nativeEvent;
    atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
  };
  const roots = tasks.filter((task) => !task.parentTaskId || !state.tasks[task.parentTaskId]);
  const timeline = chatTimeline(state.messages, roots);
  const inbox = Object.values(state.inbox);
  // As on the web: a finished task whose row already shows its outcome is not announced again here;
  // its card waits on Home.
  const shown = new Set(roots.filter((task) => task.manifest).map((task) => task.taskId));
  const waiting = inbox.filter(
    (item) =>
      item.state !== 'closed' &&
      !(item.kind === 'finished' && item.taskId !== null && shown.has(item.taskId)),
  );
  /** Tasks a card is waiting on the person for. */
  const waitsOn = new Set(
    waiting
      .filter((item) => item.state === 'open')
      .flatMap((item) => (item.taskId ? [item.taskId] : [])),
  );
  // Something that waits on the person is always brought into view.
  const needsYou = openQuestions.size + waiting.length;
  useEffect(() => {
    if (needsYou > 0) {
      atEnd.current = true;
      scroll.current?.scrollToEnd({ animated: !reduce });
    }
  }, [needsYou, reduce]);
  // Once the conversation shows the message that was on its way, it is in the list itself. That
  // holds for one whose send looked failed too: the server may have taken it before the answer
  // was lost.
  const sentByPerson = state.messages.filter((message) => message.role === 'user');
  // (The server names a message by an id of its own, not the send's, so it is known by its words.)
  const arrivedOutgoing =
    outgoing !== undefined &&
    sentByPerson.some(
      (message) => !outgoing.seen?.has(message.id) && message.text.trim() === outgoing.text,
    );
  useEffect(() => {
    if (!arrivedOutgoing) return;
    // It is done with: the next message is a new one, with an id of its own.
    feed.draftEdited();
    keptSends.delete(conversationId);
    setOutgoing(undefined);
  }, [arrivedOutgoing, feed, conversationId]);
  const pending = arrivedOutgoing ? undefined : outgoing;
  // A question or decision waiting on the person is not work; a reply still owed is.
  const nothingWaits = openQuestions.size === 0 && waiting.length === 0;
  const owed = nothingWaits && !pending && state.messages.at(-1)?.role === 'user';
  const workingOn = (blockTasks: readonly TaskView[], last: boolean) =>
    !blockTasks.some((task) => waitsOn.has(task.taskId)) &&
    (blockTasks.some(quietlyLive) || (last && owed));
  // Messages and cards that arrive while the chat is open rise into place; the history does not.
  const arrived = useArrivals(
    [
      ...timeline.map((item) => item.key),
      ...questions.map((question) => question.questionId),
      ...waiting.map((item) => item.itemId),
    ],
    status === 'Live' || state.messages.length > 0,
  );
  const post = (text: string) => {
    void feed
      .send(text)
      .then((sent) =>
        setOutgoing((now) =>
          now && now.text === text ? { ...now, state: sent ? 'sent' : 'failed' } : now,
        ),
      );
  };
  // The words move into the list at once: the person sees them taken before the server answers.
  const send = () => {
    const text = draft.trim();
    if (!text || busy || pending) return;
    const seen = new Set(sentByPerson.map((message) => message.id));
    // Kept with the send, so a later visit still tells it from older messages with the same words.
    seenAtSend.set(conversationId, seen);
    setOutgoing({ text, state: 'sending', seen });
    setDraft('');
    post(text);
  };
  const resend = () => {
    if (!pending || busy) return;
    setOutgoing({ ...pending, state: 'sending' });
    post(pending.text);
  };
  const discard = () => {
    // The next message is a new one: the failed one's id is not used again.
    feed.draftEdited();
    keptSends.delete(conversationId);
    setOutgoing(undefined);
  };
  const togglePill = (taskId: string) =>
    setOpened((now) => {
      const next = new Set(now);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  // "From task": back up to the task's pill, opened.
  const goToTask = (taskId: string) => {
    const index = timeline.findIndex((item) => item.key === `task-${taskId}`);
    if (index < 0) return;
    setOpened((now) => new Set(now).add(taskId));
    atEnd.current = false;
    scroll.current?.scrollToIndex({ index, animated: !reduce, viewPosition: 0.3 });
  };

  const renderItem = ({ item }: { item: ChatItem }) => {
    switch (item.type) {
      case 'message':
        return (
          <Appear enter={arrived(item.key)}>
            <Bubble message={item.message} />
          </Appear>
        );
      case 'work':
        return <WorkBlock tasks={item.tasks} working={workingOn(item.tasks, item.last)} />;
      case 'task': {
        const task = item.task;
        const open = opened.has(task.taskId);
        return (
          <Appear enter={arrived(item.key)}>
            <View style={{ gap: 10, marginBottom: 18 }}>
              <TaskPill
                task={task}
                waiting={waitsOn.has(task.taskId)}
                open={open}
                onToggle={() => togglePill(task.taskId)}
              />
              {open && (
                <Card label={say('chat.running.label')}>
                  <TaskRow
                    task={task}
                    tasks={tasks}
                    noPause={noPause}
                    busy={Boolean(busy)}
                    resultCard
                    onControl={(taskId: string, action: TaskControl) =>
                      void feed.act(`${action}-${taskId}`, () => feed.control(taskId, action))
                    }
                  />
                </Card>
              )}
            </View>
          </Appear>
        );
      }
      case 'result':
        return (
          <Appear enter={arrived(item.key)}>
            <View style={{ gap: 14, marginBottom: 18 }}>
              <TaskDelivery
                client={client}
                task={item.task}
                listings={snapshot.artifacts[item.task.taskId]?.listings ?? []}
                onOpenTask={setDetail}
                onFromTask={() => goToTask(item.task.taskId)}
              />
            </View>
          </Appear>
        );
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <FlatList
          ref={scroll}
          data={timeline}
          keyExtractor={(item) => item.key}
          initialNumToRender={20}
          windowSize={7}
          onContentSizeChange={() =>
            atEnd.current && scroll.current?.scrollToEnd({ animated: false })
          }
          onScrollEndDrag={trackEnd}
          onMomentumScrollEnd={trackEnd}
          // An item far up the list may not be measured yet: go near it first, then to it.
          onScrollToIndexFailed={({ index, averageItemLength }) => {
            scroll.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
            setTimeout(
              () => scroll.current?.scrollToIndex({ index, animated: !reduce, viewPosition: 0.3 }),
              100,
            );
          }}
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
            pending ? undefined : (
              <Opening
                busy={busy === 'message'}
                onIdea={(words) => {
                  setDraft(words);
                  feed.draftEdited();
                }}
              />
            )
          }
          renderItem={renderItem}
          ListFooterComponent={
            <View style={{ gap: 14 }}>
              {pending && (
                <View>
                  <OutgoingBubble
                    outgoing={pending}
                    busy={Boolean(busy)}
                    onResend={resend}
                    onDiscard={discard}
                  />
                  {/* Taken: the agent is on it before the conversation shows the message. */}
                  {pending.state === 'sent' && <WorkBlock tasks={[]} working />}
                </View>
              )}
              {questions.map((question) => {
                const answered = state.answers[question.questionId];
                const block = (
                  <QuestionBlock
                    question={question}
                    answered={answered}
                    disabled={Boolean(busy)}
                    onAnswer={(optionId, text) =>
                      void feed.answerQuestion(question, optionId, text)
                    }
                  />
                );
                return (
                  <Appear key={question.questionId} enter={arrived(question.questionId)}>
                    {answered ? block : <Card label={say('chat.decision.label')}>{block}</Card>}
                  </Appear>
                );
              })}
              {waiting
                .filter((item) => !openQuestions.has(displayText(item.ask).trim()))
                .map((item) => {
                  const card = (
                    <DecisionCard
                      item={item}
                      task={item.taskId ? state.tasks[item.taskId] : undefined}
                      disabled={Boolean(busy)}
                      onAnswer={(optionId, text) => void feed.answerItem(item, optionId, text)}
                    />
                  );
                  return (
                    <Appear key={item.itemId} enter={arrived(item.itemId)}>
                      {item.state === 'answering' ? (
                        card
                      ) : (
                        <Card label={say('chat.needsYou.label')}>{card}</Card>
                      )}
                    </Appear>
                  );
                })}
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
              // While a send is unsettled its id is kept for "Send again", whatever is typed
              // meanwhile: the new words cannot be sent until it is sent again or deleted.
              if (!pending) feed.draftEdited();
            }}
            sending={busy === 'message'}
            // A message on its way, or one that failed, is settled first (sent again or deleted),
            // so a new one never takes its id.
            disabled={Boolean(busy) || pending !== undefined}
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
    </View>
  );
}
