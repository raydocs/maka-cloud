import {
  ConversationFeed,
  conversationSummary,
  displayText,
  dollars,
  type TaskControl,
  totalCost,
} from '@maka-cloud/client';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { DecisionCard, QuestionBlock } from '@/components/Decision';
import { TaskRow } from '@/components/TaskRow';
import { Card, Field, PillButton, RoundButton, Screen, T } from '@/components/ui';
import { useWorkspace } from '@/lib/session';
import { useTheme } from '@/lib/theme';

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
  useEffect(() => {
    feed.start();
    return () => feed.stop();
  }, [feed]);
  const snapshot = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const { state, status, error, busy, noPause } = snapshot;
  const { tasks, questions, running, openQuestions } = conversationSummary(snapshot);
  const total = totalCost(tasks);
  const [draft, setDraft] = useState('');
  const [picking, setPicking] = useState(false);
  const scroll = useRef<{ scrollToEnd(options?: { animated?: boolean }): void } | null>(null);
  const roots = tasks.filter((task) => !task.parentTaskId || !state.tasks[task.parentTaskId]);
  const inbox = Object.values(state.inbox);
  const waiting = inbox.filter((item) => item.state !== 'closed');

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
          <T kind="small" accessibilityRole="text">
            {status === 'Live' ? '● Live' : `○ ${status}`}
          </T>
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
      <ScrollView
        ref={(node) => {
          scroll.current = node as unknown as typeof scroll.current;
        }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        contentContainerStyle={{ padding: 16, gap: 14 }}
        keyboardShouldPersistTaps="handled"
        accessibilityLabel="Messages"
      >
        {state.messages.length === 0 && (
          <Card label="Empty conversation">
            <T kind="heading">What would you like to get done?</T>
            <T kind="muted">Bring a question, a project, or a plan. We’ll keep the work here.</T>
          </Card>
        )}
        {state.messages.map((message) => (
          <View
            key={message.id}
            style={[
              { maxWidth: '88%', gap: 2 },
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
              {message.role === 'user' ? 'You' : message.role === 'notice' ? 'Update' : 'Maka'}
            </T>
            <T kind="body" selectable>
              {displayText(message.text)}
            </T>
          </View>
        ))}
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
      </ScrollView>
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
          onPress={() => void feed.send(draft).then((sent) => sent && setDraft(''))}
        />
      </View>
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
