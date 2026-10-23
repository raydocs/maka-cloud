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
  taskLabel,
  type TaskView,
} from '@maka-cloud/client';
import { useFocusEffect, useRouter } from 'expo-router';
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
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  Pressable,
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
import { type Idea, startersFor, useProjects } from '@/lib/ideas';
import { keepLive } from '@/lib/live';
import { useWorkspace } from '@/lib/session';
import {
  STEER_MAX_CHARS,
  type Steer,
  type SteerPhase,
  steerPhase,
  steerTarget,
  unsettled,
  useSteers,
  withdrawable,
} from '@/lib/steer';
import type { Key } from '@/lib/strings';
import { radius, useTheme } from '@/lib/theme';
import { type ChatItem, chatTimeline } from '@/lib/work';

type Message = ConversationState['messages'][number];

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

/**
 * An opening line and ideas: what an empty chat says before anything has been said. The ideas come
 * from the person's own projects and conversations (`startersFor`); one fills the box, or opens a
 * conversation they already have, and never sends anything.
 */
function Opening({
  ideas,
  onIdea,
  busy,
}: {
  ideas: readonly Idea[];
  onIdea: (words: string) => void;
  busy: boolean;
}) {
  const { t: say } = useT();
  const { open } = useWorkspace();
  return (
    <View style={{ gap: 12 }} accessibilityLabel={say('home.ideas.label')}>
      <T kind="heading">{say('chat.empty.title')}</T>
      <T kind="muted">{say('chat.empty.body', { name: BRAND.name })}</T>
      <ButtonRow>
        {ideas.map((idea) => (
          <PillButton
            key={idea.id}
            label={idea.label}
            id={idea.id}
            compact
            disabled={busy}
            onPress={() => (idea.open !== undefined ? open(idea.open) : onIdea(idea.fill))}
          />
        ))}
      </ButtonRow>
    </View>
  );
}

/** The Chat tab with no conversation open: it can still be talked to; the first message starts one. */
function NewConversation() {
  const { client, conversations, started } = useWorkspace();
  const { t: say, tx } = useT();
  const projects = useProjects(client);
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
          ideas={startersFor(projects, conversations, undefined, say)}
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

/** Where a message to a running task stands, in words. */
const STEER_WORDS: Record<SteerPhase, Key> = {
  sent: 'steer.sent',
  failed: 'chat.notSent',
  received: 'steer.received',
  queued: 'steer.queued',
  applying: 'steer.applying',
  read: 'steer.read',
  withdrawn: 'steer.withdrawn',
  unread: 'steer.unread',
  unknown: 'steer.unknown',
};

/**
 * What the person told a running task, on their side like their messages, marked as going to the
 * task, with where it stands under it. One taken back is faint.
 */
function SteerBubble({
  steer,
  phase,
  onWithdraw,
}: {
  steer: Steer;
  phase: SteerPhase;
  /** For a message that is not the latest: its own "Take back" while the agent has not read it. */
  onWithdraw?: () => void;
}) {
  const theme = useTheme();
  const { t: say, tx } = useT();
  const status = say(STEER_WORDS[phase]);
  return (
    <View
      testID="steer-bubble"
      style={{
        alignSelf: 'flex-end',
        maxWidth: '85%',
        gap: 4,
        marginBottom: 18,
        backgroundColor: theme.chip,
        borderRadius: radius.card,
        paddingHorizontal: 16,
        paddingVertical: 10,
        opacity: phase === 'withdrawn' ? 0.6 : 1,
      }}
    >
      {/* Read as one line; the button after it is its own stop. */}
      <View
        accessible
        accessibilityLabel={say('steer.said', { text: withoutMarks(steer.text), status })}
        style={{ gap: 4 }}
      >
        <T kind="small">{say('steer.marker')}</T>
        <Rich text={steer.text} />
        <T kind="small" testID={`steer-phase-${phase}`}>
          {status}
        </T>
      </View>
      {onWithdraw && withdrawable(phase) && (
        <QuietButton
          label={say('steer.withdraw')}
          accessibilityLabel={say('steer.withdrawOne', { text: withoutMarks(steer.text) })}
          id="Take back earlier"
          disabled={steer.request !== undefined}
          onPress={onWithdraw}
        />
      )}
      {/* Why its own take-back failed; the latest message says so by the composer instead. */}
      {onWithdraw && steer.failed && phase !== 'failed' ? (
        <View accessibilityLiveRegion="polite">
          <T kind="small">{tx(steer.failed)}</T>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Under the latest message to a running task, by the composer: where it stands while it moves,
 * with "Take back" while the agent has not read it, or "Send again" and "Delete" when it did not
 * reach the server.
 */
function SteerState({
  steer,
  phase,
  onWithdraw,
  onResend,
  onDiscard,
}: {
  steer: Steer;
  phase: SteerPhase;
  onWithdraw: () => void;
  onResend: () => void;
  onDiscard: () => void;
}) {
  const { t: say, tx } = useT();
  const words = steer.request === 'withdraw' ? say('steer.withdrawing') : say(STEER_WORDS[phase]);
  return (
    <View
      testID="steer-state"
      accessibilityLiveRegion="polite"
      style={{ gap: 2, alignSelf: 'stretch', paddingHorizontal: 8 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <T kind="small" style={{ flexShrink: 1 }}>
          {words}
        </T>
        {withdrawable(phase) && (
          <QuietButton
            label={say('steer.withdraw')}
            id="Take back"
            disabled={steer.request !== undefined}
            onPress={onWithdraw}
          />
        )}
        {phase === 'failed' && (
          <>
            <QuietButton label={say('chat.resend')} id="Send again" onPress={onResend} />
            <QuietButton label={say('chat.discard')} id="Delete" onPress={onDiscard} />
          </>
        )}
      </View>
      {steer.failed && phase !== 'applying' ? <T kind="small">{tx(steer.failed)}</T> : null}
    </View>
  );
}

/**
 * "To the running task": on while a task in this conversation is still going, so what is sent
 * goes to that task; one tap turns it off, and what is sent goes to the conversation again.
 */
function SteerChip({ task, on, onToggle }: { task: TaskView; on: boolean; onToggle: () => void }) {
  const theme = useTheme();
  const { t: say } = useT();
  const title = task.title ? displayText(task.title) : say('task.title');
  return (
    <Pressable
      testID="steer-chip"
      accessibilityRole="switch"
      accessibilityLabel={say('steer.chipLabel', { title })}
      accessibilityState={{ checked: on }}
      onPress={onToggle}
      hitSlop={6}
      style={({ pressed }) => ({
        flexShrink: 1,
        minHeight: 32,
        justifyContent: 'center',
        paddingHorizontal: 12,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: on ? theme.pillOn : theme.cardEdge,
        backgroundColor: on ? theme.pillOn : theme.chip,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <T kind="small" numberOfLines={1} style={{ color: on ? theme.onPillOn : theme.ink }}>
        {say('steer.chip', { title })}
      </T>
    </Pressable>
  );
}

/**
 * The state of things, each on its own line, only while the stream is not live: the connection
 * (with the reassurance that the work goes on and nothing needs sending again), the task as last
 * seen, and the machine when its stop is not confirmed. Being offline never reads as the task failing.
 */
function StatusLines({
  status,
  task,
  stopping,
}: {
  status: string;
  task: TaskView | undefined;
  stopping: boolean;
}) {
  const { t: say, tx } = useT();
  const live = status === 'Live';
  if (live && !stopping) return null;
  const dropped = status === 'Reconnecting…' || status === 'Disconnected';
  const connection = status === 'Disconnected' ? say('status.offline') : tx(status);
  const line = (label: Key, value: string) => say('status.line', { label: say(label), value });
  return (
    <View testID="status-lines" style={{ gap: 2, alignItems: 'center' }}>
      {!live && (
        <View
          testID="status-connection"
          accessible
          accessibilityRole="text"
          accessibilityLabel={
            dropped
              ? `${line('status.connection', connection)}${say('work.join')}${say('status.keepsGoing')}`
              : line('status.connection', connection)
          }
          style={{ alignItems: 'center', gap: 2 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {status !== 'Connecting…' && <StatusMark tone="idle" />}
            <T kind="small">{line('status.connection', connection)}</T>
          </View>
          {dropped && (
            <T kind="small" testID="status-keeps-going" style={{ textAlign: 'center' }}>
              {say('status.keepsGoing')}
            </T>
          )}
        </View>
      )}
      {!live && task && (
        <T kind="small" testID="status-task">
          {line('status.task', say('status.lastSeen', { state: tx(taskLabel(task)) }))}
        </T>
      )}
      {stopping && (
        <T kind="small" testID="status-machine">
          {line('status.machine', say('status.stopping'))}
        </T>
      )}
    </View>
  );
}

/** How many decisions wait below the screen; a tap goes to them. Only the attention colour's dot. */
function WaitingChip({ count, onPress }: { count: number; onPress: () => void }) {
  const theme = useTheme();
  const { t: say } = useT();
  return (
    <Pressable
      testID="waiting-chip"
      accessibilityRole="button"
      accessibilityLabel={say('chat.waitingChipLabel', { count })}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: theme.cardEdge,
        backgroundColor: theme.solid,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <StatusMark tone="attention" />
      <T kind="small" style={{ color: theme.ink }}>
        {say('chat.waitingChip', { count })}
      </T>
    </Pressable>
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
  const router = useRouter();
  const openGrants = () => router.push('/me');
  const steering = useSteers(client, conversationId);
  const projects = useProjects(client);
  const scroll = useRef<FlatList<ChatItem> | null>(null);
  /** The newest messages stay in view only while the person is already reading them. */
  const atEnd = useRef(true);
  // Only the person's own scrolling decides this; a scroll the list makes while measuring does not.
  const trackEnd = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = nativeEvent;
    atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
  };
  /**
   * Where the decision cards sit against what is on screen. The cards are the end of the list's
   * footer, so their top is the content's height less the bottom padding, less the footer, plus
   * where they start in it.
   */
  const where = useRef({ offset: 0, viewport: 0, content: 0, footer: 0 });
  /** Where each open card sits in the footer (its top and height), by its id. */
  const tops = useRef(new Map<string, { y: number; height: number }>());
  /** The open cards none of which can be seen, top to bottom, by where they start in the list. */
  const [hiddenCards, setHiddenCards] = useState<readonly number[]>([]);
  const measure = (change: Partial<typeof where.current> = {}) => {
    const at = Object.assign(where.current, change);
    if (at.viewport === 0 || at.content === 0 || tops.current.size === 0) {
      setHiddenCards((now) => (now.length === 0 ? now : []));
      return;
    }
    const padding = dock + 16;
    const hidden = [...tops.current.values()]
      .map(({ y, height }) => ({ top: at.content - padding - at.footer + y, height }))
      // Below the composer's top edge, or scrolled up under the top bar: none of it can be seen.
      .filter(
        ({ top, height }) =>
          top > at.offset + at.viewport - dock || top + height < at.offset + TOP_BAR,
      )
      .map(({ top }) => top)
      .sort((a, b) => a - b);
    setHiddenCards((now) =>
      now.length === hidden.length && now.every((top, i) => top === hidden[i]) ? now : hidden,
    );
  };
  const placeCard = (key: string) => (event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    tops.current.set(key, { y, height });
    measure();
  };
  const roots = tasks.filter((task) => !task.parentTaskId || !state.tasks[task.parentTaskId]);
  const timeline = chatTimeline(state.messages, roots, steering.steers);
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

  // Talking to a running task. The chip is on whenever a task here is still going, unless the
  // person turned it off for that task.
  const target = steerTarget(roots);
  const [steerOff, setSteerOff] = useState<string | undefined>();
  const [refusedNote, setRefusedNote] = useState<false | 'refused' | 'tooLong'>(false);
  const steerOn = target !== undefined && steerOff !== target.taskId;
  const phaseOf = (steer: Steer) => steerPhase(steer, state.tasks[steer.taskId]);
  const lastSteer = steering.steers.at(-1);
  const lastPhase = lastSteer && phaseOf(lastSteer);
  // A message to a task on its way, or one that did not get there, is settled first.
  const steerHolds = lastSteer?.request === 'send' || lastPhase === 'failed';
  // Messages the agent may not have read yet: asked about again when the task shows it took a
  // step (at most every 8 seconds) and every 20 seconds, by sending each again unchanged.
  const moving = steering.steers.filter((steer) => {
    const phase = phaseOf(steer);
    return phase === 'received' || phase === 'queued';
  });
  const activity = moving
    .map((steer) => {
      const task = state.tasks[steer.taskId];
      return `${steer.id}:${task?.state}:${task?.progress.length}:${task?.narration}:${task?.panels?.length}`;
    })
    .join('|');
  const latest = useRef({ steering, moving });
  latest.current = { steering, moving };
  const checked = useRef(Date.now());
  const turn = useRef(0);
  /** Checks run only while this screen is in front and the app is in the foreground. */
  const inFront = useRef(false);
  useFocusEffect(
    useCallback(() => {
      inFront.current = true;
      return () => {
        inFront.current = false;
      };
    }, []),
  );
  useEffect(() => {
    if (activity === '') return;
    // One request a round, whatever the backlog: the oldest message a task may not have read yet
    // (the server hands them over in order), taking the tasks in turn. At most about ten a minute,
    // so Stop and Take back keep most of the shared control budget (30 a minute).
    const check = () => {
      const app = AppState.currentState;
      // (Before the first report an app's state can read as unknown: that does not hold checks.)
      if (!inFront.current || app === 'background' || app === 'inactive') return;
      checked.current = Date.now();
      const oldest = new Map<string, string>();
      for (const steer of latest.current.moving)
        if (!oldest.has(steer.taskId)) oldest.set(steer.taskId, steer.id);
      const ids = [...oldest.values()];
      if (ids.length === 0) return;
      const id = ids[turn.current++ % ids.length];
      if (id) latest.current.steering.check(id);
    };
    if (Date.now() - checked.current >= 8_000) check();
    const timer = setInterval(check, 20_000);
    return () => clearInterval(timer);
  }, [activity]);
  // A task that ended with a message still pending: its log says whether the agent read it.
  const toSettle = steering.steers
    .filter(
      (steer) =>
        steer.server === 'pending' &&
        !steer.settled &&
        !steer.request &&
        phaseOf(steer) === 'unknown',
    )
    .map((steer) => steer.id)
    .join(',');
  useEffect(() => {
    for (const id of toSettle.split(',').filter(Boolean)) latest.current.steering.settle(id);
  }, [toSettle]);
  /** The latest message to a task, by the composer while it moves or did not get there. */
  const steerLine =
    lastSteer &&
    lastPhase &&
    (unsettled(lastPhase) || lastPhase === 'failed' || lastPhase === 'applying')
      ? { steer: lastSteer, phase: lastPhase }
      : undefined;
  const sendToTask = (task: TaskView, text: string) => {
    checked.current = Date.now();
    void steering.send(task.taskId, text).then((taken) => {
      if (taken) return;
      // This task takes no messages now: the words go back, and the next send goes to the
      // conversation.
      setDraft((now) => (now.trim() === '' ? text : now));
      setSteerOff(task.taskId);
      setRefusedNote('refused');
    });
  };
  /** Open decisions, as the cards below show them; a card answered since is no longer placed. */
  const openCards = new Set([
    ...questions
      .filter((question) => !state.answers[question.questionId])
      .map((question) => question.questionId),
    ...waiting
      .filter((item) => item.state === 'open' && !openQuestions.has(displayText(item.ask).trim()))
      .map((item) => item.itemId),
  ]);
  for (const key of [...tops.current.keys()]) if (!openCards.has(key)) tops.current.delete(key);
  /** To the first card that cannot be seen. */
  const toCards = () => {
    const first = hiddenCards[0];
    if (first === undefined) return;
    atEnd.current = false;
    scroll.current?.scrollToOffset({
      offset: Math.max(0, first - TOP_BAR - 16),
      animated: !reduce,
    });
  };
  const stopping = roots.some((task) => task.stopPending || task.treeStopPending);
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
    if (!text || busy || pending || steerHolds) return;
    setRefusedNote(false);
    if (steerOn && target) {
      // Over the server's limit for a message to a task: the words stay in the box to shorten.
      if (text.length > STEER_MAX_CHARS) {
        setRefusedNote('tooLong');
        return;
      }
      setDraft('');
      sendToTask(target, text);
      return;
    }
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
      case 'steer':
        return (
          <Appear enter={arrived(item.key)}>
            <SteerBubble
              steer={item.steer}
              phase={phaseOf(item.steer)}
              {...(item.steer.id === lastSteer?.id
                ? {}
                : { onWithdraw: () => steering.withdraw(item.steer.id) })}
            />
          </Appear>
        );
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
          onContentSizeChange={(_, height) => {
            measure({ content: height });
            if (atEnd.current) scroll.current?.scrollToEnd({ animated: false });
          }}
          onLayout={(event) => measure({ viewport: event.nativeEvent.layout.height })}
          onScroll={(event) => measure({ offset: event.nativeEvent.contentOffset.y })}
          scrollEventThrottle={100}
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
                ideas={startersFor(projects, conversations, conversationId, say)}
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
            <View
              testID="chat-footer"
              style={{ gap: 14 }}
              onLayout={(event) => measure({ footer: event.nativeEvent.layout.height })}
            >
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
                    onOpenGrants={openGrants}
                  />
                );
                return (
                  <View
                    key={question.questionId}
                    testID={`decision-slot-${question.questionId}`}
                    {...(answered ? {} : { onLayout: placeCard(question.questionId) })}
                  >
                    <Appear enter={arrived(question.questionId)}>
                      {answered ? block : <Card label={say('chat.decision.label')}>{block}</Card>}
                    </Appear>
                  </View>
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
                      onAnswer={(optionId, text) => feed.answerItem(item, optionId, text)}
                      onOpenGrants={openGrants}
                    />
                  );
                  return (
                    <View
                      key={item.itemId}
                      testID={`decision-slot-${item.itemId}`}
                      {...(item.state === 'open' ? { onLayout: placeCard(item.itemId) } : {})}
                    >
                      <Appear enter={arrived(item.itemId)}>
                        {item.state === 'answering' ? (
                          card
                        ) : (
                          <Card label={say('chat.needsYou.label')}>{card}</Card>
                        )}
                      </Appear>
                    </View>
                  );
                })}
              {error ? <T kind="error">{tx(error)}</T> : null}
            </View>
          }
        />
        <TopFade />
        <Dock height={dock} onHeight={setDock}>
          {/* Nothing to say while connected; a dropped connection, and the task as last seen, are
              each their own line. */}
          <StatusLines status={status} task={target} stopping={stopping} />
          {steerLine && (
            <SteerState
              steer={steerLine.steer}
              phase={steerLine.phase}
              onWithdraw={() => steering.withdraw(steerLine.steer.id)}
              onResend={() => steering.resend(steerLine.steer.id)}
              onDiscard={() => steering.discard(steerLine.steer.id)}
            />
          )}
          {refusedNote && (
            <T kind="small" testID="steer-refused" style={{ paddingHorizontal: 8 }}>
              {say(refusedNote === 'tooLong' ? 'steer.tooLong' : 'steer.refused')}
            </T>
          )}
          {(target || hiddenCards.length > 0) && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {target && (
                <SteerChip
                  task={target}
                  on={steerOn}
                  onToggle={() => {
                    setRefusedNote(false);
                    setSteerOff(steerOn ? target.taskId : undefined);
                  }}
                />
              )}
              <View style={{ flex: 1 }} />
              {hiddenCards.length > 0 && (
                <WaitingChip count={hiddenCards.length} onPress={toCards} />
              )}
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
            sending={busy === 'message' || lastSteer?.request === 'send'}
            // A message on its way, or one that failed, is settled first (sent again or deleted),
            // so a new one never takes its id.
            disabled={Boolean(busy) || pending !== undefined || steerHolds}
            onSend={send}
            onPlus={openSheet}
            {...(steerOn
              ? { placeholder: say('steer.placeholder'), sendLabel: say('steer.send') }
              : {})}
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
