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
  Pressable,
  View,
} from 'react-native';
import { DecisionCard, QuestionBlock } from '@/components/Decision';
import { TaskDelivery } from '@/components/Delivery';
import { TaskDetails } from '@/components/TaskDetails';
import { TaskRow } from '@/components/TaskRow';
import { Card, Field, PillButton, RoundButton, Screen, StatusMark, T } from '@/components/ui';
import { keepLive } from '@/lib/live';
import { useWorkspace } from '@/lib/session';
import { useTheme } from '@/lib/theme';

type Message = ConversationState['messages'][number];

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
        <View style={{ padding: 16 }}>
          <Card label="No conversation">
            <T kind="heading">No conversation open</T>
            <T kind="muted">Start one from Home.</T>
          </Card>
        </View>
      )}
    </Screen>
  );
}

function ConversationScreen({ conversationId }: { conversationId: string }) {
  const { client, conversations, open } = useWorkspace();
  const theme = useTheme();
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
  const waiting = inbox.filter((item) => item.state !== 'closed');
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
      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 4 }}>
        <T kind="title" numberOfLines={2}>
          {displayText(conversation?.title ?? 'A fresh start')}
        </T>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <View
            accessible
            accessibilityRole="text"
            accessibilityLabel={status === 'Live' ? 'Live' : status}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
          >
            <StatusMark tone={status === 'Live' ? 'ok' : 'idle'} />
            <T kind="small">{status === 'Live' ? 'Live' : status}</T>
          </View>
          {conversations.length > 1 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Select conversation"
              onPress={() => setPicking(true)}
              style={{ minHeight: 44, justifyContent: 'center' }}
            >
              <T kind="muted" style={{ textDecorationLine: 'underline' }}>
                Switch
              </T>
            </Pressable>
          )}
        </View>
      </View>
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
        contentContainerStyle={{ padding: 16, gap: 14 }}
        keyboardShouldPersistTaps="handled"
        accessibilityLabel="Messages"
        ListEmptyComponent={
          <Card label="Empty conversation">
            <T kind="heading">What would you like to get done?</T>
            <T kind="muted">Bring a question, a project, or a plan. We’ll keep the work here.</T>
          </Card>
        }
        renderItem={({ item: message }) => (
          <View
            style={[
              { maxWidth: '88%', gap: 2, marginBottom: 14 },
              message.role === 'user'
                ? {
                    alignSelf: 'flex-end',
                    backgroundColor: theme.chip,
                    borderRadius: 16,
                    padding: 12,
                  }
                : { alignSelf: 'flex-start' },
            ]}
          >
            <T kind="small">
              {message.role === 'user' ? 'You' : message.role === 'notice' ? 'Update' : BRAND.name}
            </T>
            <T kind="body" selectable>
              {displayText(message.text)}
            </T>
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
              <Card label="The work">
                <T kind="small">
                  {running} running · Total cost so far: {dollars(total.usd)}
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
                  onAnswer={(optionId, text) => void feed.answerQuestion(question, optionId, text)}
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
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end', padding: 12 }}>
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
          />
        </View>
        <RoundButton
          label={busy === 'message' ? 'Sending…' : 'Send message'}
          glyph="↑"
          disabled={Boolean(busy) || !draft.trim()}
          onPress={() => {
            const sending = draft;
            // Words typed while it was sending stay in the box.
            void feed
              .send(sending)
              .then((sent) => sent && setDraft((now) => (now === sending ? '' : now)));
          }}
        />
      </View>
      {detail && (
        <TaskDetails
          client={client}
          task={state.tasks[detail.taskId] ?? detail}
          onClose={() => setDetail(undefined)}
        />
      )}
      <Modal
        visible={picking}
        transparent
        animationType="slide"
        onRequestClose={() => setPicking(false)}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
          <Card label="Conversations">
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
