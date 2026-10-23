import {
  BRAND,
  type Conversation,
  ConversationFeed,
  ConversationStarter,
  errorText,
  type TaskView,
  conversationSummary,
  displayText,
  dollars,
  type ConversationState,
  type TaskControl,
  TERMINAL,
  totalCost,
} from '@maka-cloud/client';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  View,
} from 'react-native';
import { DecisionCard, QuestionBlock } from '@/components/Decision';
import { TaskDelivery } from '@/components/Delivery';
import { TaskDetails } from '@/components/TaskDetails';
import { TaskRow } from '@/components/TaskRow';
import {
  Appear,
  ButtonRow,
  Card,
  Fade,
  Field,
  Glass,
  GlassButton,
  GlassGroup,
  Panel,
  PillButton,
  Rich,
  RoundButton,
  Screen,
  Shimmer,
  StatusMark,
  T,
  withoutMarks,
} from '@/components/ui';
import { useAppearance } from '@/lib/appearance';
import { useT } from '@/lib/i18n';
import { keepLive } from '@/lib/live';
import { useWorkspace } from '@/lib/session';
import { DARK, LIGHT, mono, radius, ThemeContext, useTheme } from '@/lib/theme';

type Message = ConversationState['messages'][number];

/** What an empty chat offers to start with; a tap puts it in the box, the person sends it. */
const IDEAS = ['home.idea.1', 'home.idea.2', 'home.idea.3'] as const;

export default function Chat() {
  const { conversations, chosen } = useWorkspace();
  const selected = conversations.find((c) => c.conversationId === chosen);
  return (
    <Screen>
      <Panel>
        {selected ? (
          <ConversationScreen
            key={selected.conversationId}
            conversationId={selected.conversationId}
          />
        ) : (
          <NewConversation />
        )}
      </Panel>
    </Screen>
  );
}

/** An opening line and three ideas: what an empty chat says before anything has been said. */
function Opening({ onIdea }: { onIdea: (words: string) => void }) {
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
            onPress={() => onIdea(say(idea))}
          />
        ))}
      </ButtonRow>
    </View>
  );
}

/**
 * The floating composer: the field and the send button blend as one glass control, with the
 * conversation picker beside them when there is more than one conversation.
 */
function Composer({
  draft,
  onDraft,
  sending,
  disabled,
  onSend,
  onPick,
}: {
  draft: string;
  onDraft: (text: string) => void;
  sending: boolean;
  disabled: boolean;
  onSend: () => void;
  onPick?: () => void;
}) {
  const { t: say } = useT();
  return (
    <GlassGroup style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
      {onPick && (
        <GlassButton
          label={say('chat.select')}
          id="Select conversation"
          icon="conversations"
          onPress={onPick}
        />
      )}
      <Glass
        interactive
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'flex-end',
          borderRadius: radius.card,
        }}
      >
        <View style={{ flex: 1 }}>
          <Field
            label={say('chat.field')}
            id="Keep the conversation going"
            placeholder={say('chat.placeholder')}
            multiline
            maxLength={16000}
            value={draft}
            onChangeText={(text) => onDraft(displayText(text))}
            style={{ backgroundColor: 'transparent', borderWidth: 0, maxHeight: 140 }}
          />
        </View>
        <RoundButton
          label={say(sending ? 'chat.sending' : 'chat.send')}
          id={sending ? 'Sending…' : 'Send message'}
          icon="send"
          disabled={disabled || !draft.trim()}
          onPress={onSend}
        />
      </Glass>
    </GlassGroup>
  );
}

/** The Chat tab with no conversation open: it can still be talked to; the first message starts one. */
function NewConversation() {
  const { client, conversations, started } = useWorkspace();
  const theme = useTheme();
  const { tx } = useT();
  const starter = useMemo(() => new ConversationStarter(client), [client]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState('');
  const [picking, setPicking] = useState(false);
  const [composer, setComposer] = useState(76);
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
      <View style={{ flex: 1, padding: 20, paddingBottom: composer + 16, gap: 12 }}>
        <Opening
          onIdea={(words) => {
            setDraft(words);
            starter.draftEdited();
          }}
        />
        {failure ? <T kind="error">{tx(failure)}</T> : null}
      </View>
      <Fade edge="bottom" height={composer + 36} color={theme.panel} clear={theme.panelClear} />
      <View
        onLayout={(event) => setComposer(Math.ceil(event.nativeEvent.layout.height))}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 12 }}
      >
        <Composer
          draft={draft}
          onDraft={(text) => {
            setDraft(text);
            starter.draftEdited();
          }}
          sending={sending}
          disabled={sending}
          onSend={send}
          {...(conversations.length > 0 ? { onPick: () => setPicking(true) } : {})}
        />
      </View>
      <ConversationPicker visible={picking} onClose={() => setPicking(false)} />
    </KeyboardAvoidingView>
  );
}

/** The conversations, newest first, on an opaque sheet; the open one is filled. */
function ConversationPicker({
  visible,
  current,
  onClose,
}: {
  visible: boolean;
  current?: string;
  onClose: () => void;
}) {
  const { conversations, open } = useWorkspace();
  const theme = useTheme();
  const { t: say } = useT();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
        {/* An opaque slab of its own: the panel's translucent cards would vanish on the dimmed screen. */}
        <Card
          label={say('chat.conversations')}
          style={{
            backgroundColor: theme.panel,
            margin: 8,
            marginBottom: 24,
            borderRadius: radius.panel,
          }}
        >
          <T kind="heading">{say('chat.conversations')}</T>
          {[...conversations].reverse().map((c) => (
            <PillButton
              key={c.conversationId}
              label={c.title ? displayText(c.title) : say('common.untitled')}
              primary={c.conversationId === current}
              onPress={() => {
                open(c.conversationId);
                onClose();
              }}
            />
          ))}
          <PillButton label={say('common.close')} id="Close" onPress={onClose} />
        </Card>
      </View>
    </Modal>
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
  // The task page opens over the whole screen, in the person's own appearance, not the panel's.
  const { mode } = useAppearance();
  /** The floating composer's height: the list scrolls on under it, by this much more. */
  const [composer, setComposer] = useState(76);
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
  const [picking, setPicking] = useState(false);
  const [detail, setDetail] = useState<TaskView | undefined>();
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
          // The list runs on under the composer, which floats over a fade.
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 20,
            paddingBottom: composer + 16,
          }}
          scrollIndicatorInsets={{ top: 12, bottom: composer }}
          keyboardShouldPersistTaps="handled"
          accessibilityLabel={say('chat.messages')}
          ListHeaderComponent={
            <T kind="heading" numberOfLines={2} style={{ marginBottom: 14 }}>
              {conversation?.title ? displayText(conversation.title) : say('chat.freshStart')}
            </T>
          }
          ListEmptyComponent={
            <Opening
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
                  <ActivityIndicator size="small" color={theme.inkMuted} />
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
        <Fade edge="top" height={20} color={theme.panel} clear={theme.panelClear} />
        <Fade edge="bottom" height={composer + 36} color={theme.panel} clear={theme.panelClear} />
        <View
          onLayout={(event) => setComposer(Math.ceil(event.nativeEvent.layout.height))}
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 12, gap: 8 }}
        >
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
            {...(conversations.length > 1 ? { onPick: () => setPicking(true) } : {})}
          />
        </View>
      </View>
      {detail && (
        <ThemeContext.Provider value={mode === 'dark' ? DARK : LIGHT}>
          <TaskDetails
            client={client}
            task={state.tasks[detail.taskId] ?? detail}
            onClose={() => setDetail(undefined)}
          />
        </ThemeContext.Provider>
      )}
      <ConversationPicker
        visible={picking}
        current={conversationId}
        onClose={() => setPicking(false)}
      />
    </KeyboardAvoidingView>
  );
}
