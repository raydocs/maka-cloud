import {
  BRAND,
  ConversationFeed,
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
import { HEADER_SPACE } from '@/components/TopBar';
import {
  Card,
  Fade,
  Field,
  Glass,
  GlassButton,
  Panel,
  PillButton,
  Rich,
  RoundButton,
  Screen,
  StatusMark,
  T,
  withoutMarks,
} from '@/components/ui';
import { useAppearance } from '@/lib/appearance';
import { keepLive } from '@/lib/live';
import { useWorkspace } from '@/lib/session';
import { DARK, LIGHT, mono, radius, ThemeContext, useTheme } from '@/lib/theme';

type Message = ConversationState['messages'][number];

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
          <View style={{ padding: 16, paddingTop: HEADER_SPACE + 8 }}>
            <Card label="No conversation">
              <T kind="heading">No conversation open</T>
              <T kind="muted">Start one from Home.</T>
            </Card>
          </View>
        )}
      </Panel>
    </Screen>
  );
}

function ConversationScreen({ conversationId }: { conversationId: string }) {
  const { client, conversations, open } = useWorkspace();
  const theme = useTheme();
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
          // The list runs on under the section pill and the composer, which float over fades.
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: HEADER_SPACE + 8,
            paddingBottom: composer + 16,
          }}
          scrollIndicatorInsets={{ top: HEADER_SPACE, bottom: composer }}
          keyboardShouldPersistTaps="handled"
          accessibilityLabel="Messages"
          ListHeaderComponent={
            <T kind="heading" numberOfLines={2} style={{ marginBottom: 14 }}>
              {displayText(conversation?.title ?? 'A fresh start')}
            </T>
          }
          ListEmptyComponent={
            <Card label="Empty conversation">
              <T kind="heading">What would you like to get done?</T>
              <T kind="muted">
                Bring a question, a project, or a plan. {BRAND.name} keeps the work here.
              </T>
            </Card>
          }
          renderItem={({ item: message }) => (
            // Who said it is plain from the side it sits on; a screen reader still hears the name.
            <View
              accessible
              accessibilityLabel={`${message.role === 'user' ? 'You' : message.role === 'notice' ? 'Update' : BRAND.name}: ${withoutMarks(displayText(message.text))}`}
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
          )}
          ListFooterComponent={
            <View style={{ gap: 14 }}>
              {working && (
                <View
                  accessible
                  accessibilityRole="text"
                  accessibilityLabel="Maka is working"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
                >
                  <ActivityIndicator size="small" color={theme.inkMuted} />
                  <T kind="muted">Maka is working…</T>
                </View>
              )}
              {roots.length > 0 && (
                <Card label="Running">
                  <T kind="small">
                    {running} running · Total cost so far:{' '}
                    <T kind="small" style={mono}>
                      {dollars(total.usd)}
                    </T>
                    {total.usd !== undefined && !total.complete && ' (not all reported)'}
                  </T>
                  {roots.map((task) => (
                    <TaskRow
                      key={task.taskId}
                      task={task}
                      tasks={tasks}
                      noPause={noPause}
                      busy={Boolean(busy)}
                      onControl={(taskId: string, action: TaskControl) =>
                        void feed.act(`${action}-${taskId}`, () => feed.control(taskId, action))
                      }
                    />
                  ))}
                </Card>
              )}
              {roots.map((task) => (
                <TaskDelivery
                  key={task.taskId}
                  client={client}
                  task={task}
                  listings={snapshot.artifacts[task.taskId]?.listings ?? []}
                  onOpenTask={setDetail}
                />
              ))}
              {questions.map((question) => (
                <Card key={question.questionId} label="Your decision">
                  <QuestionBlock
                    question={question}
                    answered={state.answers[question.questionId]}
                    disabled={Boolean(busy)}
                    onAnswer={(optionId, text) =>
                      void feed.answerQuestion(question, optionId, text)
                    }
                  />
                </Card>
              ))}
              {waiting
                .filter((item) => !openQuestions.has(displayText(item.ask).trim()))
                .map((item) => (
                  <Card key={item.itemId} label="Needs you">
                    <DecisionCard
                      item={item}
                      disabled={Boolean(busy)}
                      onAnswer={(optionId, text) => void feed.answerItem(item, optionId, text)}
                    />
                  </Card>
                ))}
              {error ? <T kind="error">{error}</T> : null}
            </View>
          }
        />
        <Fade edge="top" height={HEADER_SPACE + 24} color={theme.panel} clear={theme.panelClear} />
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
              accessibilityLabel={status}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center' }}
            >
              {status !== 'Connecting…' && <StatusMark tone="attention" />}
              <T kind="small">{status}</T>
            </View>
          )}
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            {conversations.length > 1 && (
              <GlassButton
                label="Select conversation"
                icon="conversations"
                onPress={() => setPicking(true)}
              />
            )}
            <Glass
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'flex-end',
                borderRadius: radius.card,
              }}
            >
              <View style={{ flex: 1 }}>
                <Field
                  label="Keep the conversation going"
                  placeholder="What would you like to do next?"
                  multiline
                  maxLength={16000}
                  value={draft}
                  onChangeText={(text) => {
                    setDraft(displayText(text));
                    feed.draftEdited();
                  }}
                  style={{ backgroundColor: 'transparent', borderWidth: 0, maxHeight: 140 }}
                />
              </View>
              <RoundButton
                label={busy === 'message' ? 'Sending…' : 'Send message'}
                icon="send"
                disabled={Boolean(busy) || !draft.trim()}
                onPress={() => {
                  const sending = draft;
                  // Words typed while it was sending stay in the box.
                  void feed
                    .send(sending)
                    .then((sent) => sent && setDraft((now) => (now === sending ? '' : now)));
                }}
              />
            </Glass>
          </View>
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
      <Modal
        visible={picking}
        transparent
        animationType="slide"
        onRequestClose={() => setPicking(false)}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
          {/* An opaque slab of its own: the panel's translucent cards would vanish on the dimmed screen. */}
          <Card
            label="Conversations"
            style={{
              backgroundColor: theme.panel,
              margin: 8,
              marginBottom: 24,
              borderRadius: radius.panel,
            }}
          >
            <T kind="heading">Conversations</T>
            {[...conversations].reverse().map((c) => (
              <PillButton
                key={c.conversationId}
                label={displayText(c.title ?? 'Untitled conversation')}
                primary={c.conversationId === conversationId}
                onPress={() => {
                  open(c.conversationId);
                  setPicking(false);
                }}
              />
            ))}
            <PillButton label="Close" onPress={() => setPicking(false)} />
          </Card>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}
