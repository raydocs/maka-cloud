import { BRAND, displayText, taskLabel, type TaskView } from '@maka-cloud/client';
import { useState } from 'react';
import { ActivityIndicator, LayoutAnimation, Pressable, View } from 'react-native';
import { useReduceMotion } from '@/lib/appearance';
import { useT } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import {
  doneSummary,
  liveLine,
  panelSummary,
  runnerWords,
  type WorkStep,
  workSteps,
} from '@/lib/work';
import { Icon } from './Icon';
import { Shimmer, StatusMark, T, Thinking } from './ui';

/**
 * Something still going: the system's small spinner, or under Reduce Motion a still ring, so
 * nothing on the screen turns.
 */
export function Spinner() {
  const t = useTheme();
  const reduce = useReduceMotion();
  if (reduce)
    return (
      <View
        testID="spinner-still"
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={{ width: 18, alignItems: 'center' }}
      >
        <StatusMark tone="idle" />
      </View>
    );
  return (
    <ActivityIndicator
      testID="spinner"
      size="small"
      color={t.inkMuted}
      style={{ width: 18, height: 18 }}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}

/** A step's state as one mark: a spinner while it runs, then a check or a cross; ink, never colour. */
function StepMark({ state }: { state: WorkStep['state'] }) {
  const t = useTheme();
  if (state === 'running') return <Spinner />;
  const mark =
    state === 'passed' ? (
      <Icon name="check" color={t.ink} />
    ) : state === 'failed' ? (
      <Icon name="cross" color={t.ink} />
    ) : (
      <StatusMark tone="idle" />
    );
  return (
    <View
      testID={`step-${state}`}
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ width: 18, alignItems: 'center' }}
    >
      {mark}
    </View>
  );
}

const STATE_WORDS = {
  running: 'work.state.running',
  passed: 'work.state.passed',
  failed: 'work.state.failed',
  stopped: 'work.state.stopped',
} as const;

function StepRow({ step }: { step: WorkStep }) {
  const { t: say } = useT();
  const title = runnerWords(step.title, say);
  const summary = step.summary === undefined ? undefined : panelSummary(step.summary, say);
  const said = summary ? say('work.stepLabel', { title, summary }) : title;
  return (
    <View
      testID={`work-step-${step.key}`}
      accessible
      accessibilityLabel={
        step.state === 'noted'
          ? said
          : say('work.stateLabel', { step: said, state: say(STATE_WORDS[step.state]) })
      }
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 28 }}
    >
      <StepMark state={step.state} />
      <T kind="muted" style={{ flex: 1 }} numberOfLines={2}>
        {title}
      </T>
      {summary ? (
        <T kind="small" style={{ fontVariant: ['tabular-nums'] }}>
          {summary}
        </T>
      ) : null}
    </View>
  );
}

/**
 * The work one message of the person's set going, as one block. While it works: the thinking mark
 * and one live line (the running task's narration or current step, else "working"), with a row per
 * step under it. Once done it folds to one line ("Worked for 4 min · 6 steps") that opens again.
 * A block with nothing known to show (no steps, no time) is not drawn.
 */
export function WorkBlock({ tasks, working }: { tasks: readonly TaskView[]; working: boolean }) {
  const t = useTheme();
  const { t: say } = useT();
  const reduce = useReduceMotion();
  // Unset, it follows the work: open while it runs, folded once it is done.
  const [chosen, setChosen] = useState<boolean | undefined>();
  const steps = workSteps(tasks);
  const summary = working ? '' : doneSummary(tasks, say);
  if (!working && summary === '') return null;
  const open = chosen ?? working;
  const toggle = () => {
    if (!reduce) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setChosen(!open);
  };
  const found = liveLine(tasks);
  const line = found === undefined ? undefined : runnerWords(displayText(found), say);
  return (
    <View
      testID="work-block"
      style={{ gap: 8, marginBottom: 18 }}
      accessibilityLabel={say('work.label')}
    >
      {working ? (
        <Pressable
          accessibilityRole={steps.length > 0 ? 'button' : 'text'}
          accessibilityLabel={line ?? say('chat.workingLabel', { name: BRAND.name })}
          {...(steps.length > 0 ? { accessibilityState: { expanded: open } } : {})}
          disabled={steps.length === 0}
          onPress={toggle}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 }}
        >
          <Thinking />
          <View style={{ flex: 1 }}>
            <Shimmer>
              <T kind="muted">{line ?? say('chat.working', { name: BRAND.name })}</T>
            </Shimmer>
          </View>
          {steps.length > 0 && (
            <Icon name={open ? 'chevronUp' : 'chevronDown'} color={t.inkMuted} />
          )}
        </Pressable>
      ) : (
        <Pressable
          testID="work-summary"
          accessibilityRole={steps.length > 0 ? 'button' : 'text'}
          accessibilityLabel={say('work.summaryLabel', {
            summary,
            action: say(open ? 'work.hide' : 'work.show'),
          })}
          {...(steps.length > 0 ? { accessibilityState: { expanded: open } } : {})}
          disabled={steps.length === 0}
          onPress={toggle}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 }}
        >
          <T kind="small" style={{ flex: 1, fontVariant: ['tabular-nums'] }}>
            {summary}
          </T>
          {steps.length > 0 && (
            <Icon name={open ? 'chevronUp' : 'chevronDown'} color={t.inkMuted} />
          )}
        </Pressable>
      )}
      {open && steps.length > 0 && (
        <View style={{ gap: 4, paddingLeft: 2 }}>
          {steps.map((step) => (
            <StepRow key={step.key} step={step} />
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * A task the chat started, as one pill: its live mark (a spinner, then a check or a cross; the
 * attention dot while it waits on the person), its title and its state in words. A tap opens its
 * row (the step, the cost and the controls) under it.
 */
export function TaskPill({
  task,
  waiting,
  open,
  onToggle,
}: {
  task: TaskView;
  waiting: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useTheme();
  const { t: say, tx } = useT();
  const title = task.title ? displayText(task.title) : say('task.title');
  const status = waiting ? say('pill.waiting') : tx(taskLabel(task));
  const mark =
    waiting || task.state === 'paused' ? (
      <StatusMark tone="attention" />
    ) : task.state === 'succeeded' ? (
      <Icon name="check" color={t.ink} />
    ) : task.state === 'failed' ? (
      <Icon name="cross" color={t.ink} />
    ) : task.state === 'cancelled' ? (
      <StatusMark tone="idle" />
    ) : (
      <Spinner />
    );
  return (
    <Pressable
      testID={`task-pill-${task.taskId}`}
      accessibilityRole="button"
      accessibilityLabel={say('pill.label', { title, status })}
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      style={({ pressed }) => ({
        alignSelf: 'flex-start',
        maxWidth: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 44,
        paddingHorizontal: 14,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: t.cardEdge,
        backgroundColor: t.chip,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ width: 18, alignItems: 'center' }}
      >
        {mark}
      </View>
      <T kind="body" numberOfLines={1} style={{ flexShrink: 1 }}>
        {title}
      </T>
      <T kind="small" style={{ fontVariant: ['tabular-nums'] }}>
        {status}
      </T>
    </Pressable>
  );
}
