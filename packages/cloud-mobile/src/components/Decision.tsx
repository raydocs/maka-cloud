import {
  BRAND,
  displayText,
  type EvidenceLine,
  finishedParts,
  type InboxItem,
  inboxCardModel,
  type Question,
  questionCardModel,
  type TaskView,
} from '@maka-cloud/client';
import * as Haptics from 'expo-haptics';
import { type ReactNode, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { ButtonRow, Chip, Field, PillButton, QuietButton, Solid, StatusMark, T } from './ui';
import { useT } from '@/lib/i18n';
import { type Key, SERVER_CHOICES } from '@/lib/strings';
import { mono, radius, useTheme } from '@/lib/theme';
import { heldToolOf, panelSummary, touchesOf } from '@/lib/work';
import { Icon } from './Icon';

/** Answers that stop or refuse something: they buzz a warning, every other answer taps lightly. */
const STOPPING = new Set(['reject', 'deny', 'cancel', 'stop', 'turn-off']);
const hapticFor = (optionId: string) => (STOPPING.has(optionId) ? 'warning' : 'light');

/**
 * The answers that approve a held call, by how far the approval reaches (#381): this once, the rest
 * of this task, or this repository. The two wider ones keep the approval as a revocable grant.
 */
const SCOPES: ReadonlyArray<readonly [id: string, key: Key]> = [
  ['approve', 'decision.scope.once'],
  ['approve_task', 'decision.scope.task'],
  ['approve_repository', 'decision.scope.repository'],
];
const SCOPED = new Set(SCOPES.map(([id]) => id));
const KNOWN_CHOICES = new Set(SERVER_CHOICES.map(([id, label]) => `${id}\n${label}`));

const PANEL_WORDS = {
  shell: 'task.panel.shell',
  tests: 'task.panel.tests',
  diff: 'task.panel.diff',
  review: 'task.panel.review',
  search: 'task.panel.search',
} as const;

type Option = { id: string; label: string; recommended: boolean };

/** Slot 1, what will happen: the app's sentence for the held tool, then the agent's own note. */
function WillHappen({ tool, note }: { tool: string | undefined; note?: string | undefined }) {
  const { t: say } = useT();
  return (
    <View style={{ gap: 4 }}>
      {tool !== undefined && (
        <T kind="heading" testID="decision-will">
          {tool === 'open_pull_request'
            ? say('decision.willOpenPullRequest', { name: BRAND.name })
            : say('decision.willRun', { name: BRAND.name, tool })}
        </T>
      )}
      {note ? <T kind="muted">{note}</T> : null}
    </View>
  );
}

/** Slot 2, what it touches: the repository and branches the card names, as one faint line. */
function Touches({ card }: { card: string }) {
  const { t: say } = useT();
  const { repository, branch, base } = touchesOf(card);
  const parts = [
    repository,
    branch && say('decision.touch.branch', { value: branch }),
    base && say('decision.touch.base', { value: base }),
  ].filter(Boolean);
  if (parts.length === 0) return null;
  const line = parts.join(' · ');
  return (
    <T kind="small" testID="decision-touches" accessibilityRole="text" selectable>
      {line}
    </T>
  );
}

/** Slot 3, the exact details: the card's text as sent and the held call, never paraphrased. */
function Exact({
  text,
  held,
}: {
  text: string;
  held?: { tool: string; args: string } | undefined;
}) {
  const { t: say } = useT();
  return (
    <View style={{ gap: 6 }}>
      <T kind="small">{say('decision.exact')}</T>
      <T kind="body" selectable testID="decision-exact">
        {text}
      </T>
      {held && (
        <Solid>
          <T kind="small">{say('decision.held', { tool: held.tool })}</T>
          <T kind="small" selectable style={mono}>
            {held.args}
          </T>
        </Solid>
      )}
    </View>
  );
}

function LinkLine({ line }: { line: Extract<EvidenceLine, { kind: 'link' }> }) {
  const t = useTheme();
  const href = line.href;
  return href ? (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={line.label}
      onPress={() => void Linking.openURL(href)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44 }}
    >
      <T kind="small" style={{ textDecorationLine: 'underline' }}>
        {line.label}
      </T>
      <Icon name="external" color={t.inkMuted} />
    </Pressable>
  ) : (
    <T kind="small">{line.label}</T>
  );
}

/**
 * Slot 4, evidence: small badges for what the task's checks reported (its panels: tests, the
 * change, the review) and the files it left, and its links. Only what was sent; nothing when none.
 */
function Evidence({
  lines,
  task,
}: {
  lines: readonly EvidenceLine[];
  task?: TaskView | undefined;
}) {
  const { t: say, tx } = useT();
  const panels = task?.panels ?? [];
  const files = lines.filter((line) => line.kind === 'artifact');
  const links = lines.filter((line) => line.kind === 'link');
  if (panels.length === 0 && files.length === 0 && links.length === 0) return null;
  return (
    <View style={{ gap: 6 }} testID="decision-evidence">
      <T kind="small">{say('decision.evidence')}</T>
      {(panels.length > 0 || files.length > 0) && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {panels.map((panel) => (
            <Chip key={panel.panelId}>
              {`${say(PANEL_WORDS[panel.kind])} · ${panelSummary(panel.summary, say)}`}
            </Chip>
          ))}
          {files.map((line, i) => (
            <Chip key={`file-${i}`}>{tx(line.text)}</Chip>
          ))}
        </View>
      )}
      {links.map((line, i) => (
        <LinkLine key={`link-${i}`} line={line} />
      ))}
    </View>
  );
}

/**
 * Slot 5, how far the approval reaches: once, this task or this repository, as a segmented choice
 * of the scopes the card offers. A change of scope ticks like a selection.
 */
function ScopeChoice({
  scopes,
  chosen,
  onChoose,
  disabled,
}: {
  scopes: readonly Option[];
  chosen: string;
  onChoose: (id: string) => void;
  disabled: boolean;
}) {
  const t = useTheme();
  const { t: say } = useT();
  return (
    <View style={{ gap: 6 }}>
      <T kind="small">{say('decision.scope')}</T>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={say('decision.scope')}
        style={{
          flexDirection: 'row',
          alignSelf: 'flex-start',
          maxWidth: '100%',
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: t.cardEdge,
          backgroundColor: t.chip,
          padding: 3,
          gap: 2,
        }}
      >
        {scopes.map((option) => {
          const on = option.id === chosen;
          const key = SCOPES.find(([id]) => id === option.id)?.[1] ?? 'decision.scope.once';
          return (
            <Pressable
              key={option.id}
              testID={`scope-${option.id}`}
              accessibilityRole="radio"
              accessibilityLabel={say(key)}
              accessibilityState={{ selected: on, checked: on, disabled }}
              disabled={disabled}
              hitSlop={4}
              onPress={() => {
                if (on) return;
                void Haptics.selectionAsync?.()?.catch(() => {});
                onChoose(option.id);
              }}
              style={{
                minHeight: 36,
                paddingHorizontal: 12,
                justifyContent: 'center',
                borderRadius: radius.pill,
                backgroundColor: on ? t.pillOn : 'transparent',
                flexShrink: 1,
              }}
            >
              <T
                kind="muted"
                numberOfLines={1}
                style={{ color: on ? t.onPillOn : t.ink, fontWeight: on ? '500' : '400' }}
              >
                {say(key)}
              </T>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * The answers: one pill per choice, each as wide as its label, and only the recommended one filled.
 * When the card offers approval scopes, the approving choices become the scope control above and
 * one "Go ahead" pill that answers with the chosen scope.
 */
function Answers({
  options,
  disabled,
  onAnswer,
}: {
  options: readonly Option[];
  disabled: boolean;
  onAnswer: (optionId: string) => void;
}) {
  const { t: say, choice } = useT();
  const scopes = options.filter((option) => SCOPED.has(option.id));
  // The scope control stands in for the server's own scoped answers only: an approving answer in
  // any other words keeps its own pill, so nothing it says is hidden.
  const scoped =
    scopes.some((option) => option.id !== 'approve') &&
    scopes.every((option) => KNOWN_CHOICES.has(`${option.id}\n${option.label}`));
  const [chosen, setChosen] = useState(
    scopes.find((option) => option.id === 'approve')?.id ?? scopes[0]?.id ?? '',
  );
  const approve = scopes.find((option) => option.id === chosen);
  const shown: Option[] = scoped
    ? options.flatMap((option) =>
        !SCOPED.has(option.id)
          ? [option]
          : option === scopes[0] && approve
            ? [{ ...approve, recommended: scopes.some((scope) => scope.recommended) }]
            : [],
      )
    : [...options];
  return (
    <>
      {scoped && (
        <ScopeChoice scopes={scopes} chosen={chosen} onChoose={setChosen} disabled={disabled} />
      )}
      {/* A wider scope keeps the approval: its whole meaning is said, not only "this task". */}
      {scoped && approve && approve.id !== 'approve' && (
        <T kind="small" testID="scope-meaning">
          {choice(approve.id, displayText(approve.label))}
        </T>
      )}
      <ButtonRow>
        {shown.map((option) => {
          const label = choice(option.id, displayText(option.label));
          const scopeApprove = scoped && SCOPED.has(option.id);
          return (
            <PillButton
              key={scopeApprove ? 'approve-scoped' : option.id}
              label={scopeApprove ? say('choice.approve') : label}
              accessibilityLabel={label}
              id={displayText(option.label)}
              primary={option.recommended}
              compact
              haptic={hapticFor(option.id)}
              disabled={disabled}
              onPress={() => onAnswer(option.id)}
            />
          );
        })}
      </ButtonRow>
    </>
  );
}

/** A note only when asked for: "Add a note" opens the field, focused. */
function Note({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (text: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { t: say } = useT();
  return open ? (
    <Field
      label={say('common.note')}
      id="Note"
      placeholder={say('common.note')}
      multiline
      maxLength={4000}
      value={value}
      onChangeText={(text) => onChange(displayText(text))}
      editable={!disabled}
      autoFocus
    />
  ) : (
    <QuietButton
      label={say('common.addNote')}
      id="Add a note"
      onPress={() => setOpen(true)}
      disabled={disabled}
    />
  );
}

/** A card's small first line: the attention dot while it waits, and what kind of ask it is. */
function Header({ text, open }: { text: string; open: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <StatusMark tone={open ? 'attention' : 'ok'} />
      <T kind="small">{text}</T>
    </View>
  );
}

/** An answered card, shrunk to one line. */
/**
 * An answered card, shrunk to one line. An approval keeps what was approved: "Details" opens its
 * exact text again.
 */
export function Receipt({ text, details }: { text: string; details?: ReactNode }) {
  const { t: say } = useT();
  const [open, setOpen] = useState(false);
  return (
    <View testID="decision-receipt" style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 }}>
        <StatusMark tone="ok" />
        <T kind="muted" style={{ flex: 1 }} numberOfLines={1} accessibilityRole="text">
          {text}
        </T>
        {details ? (
          <QuietButton
            label={say(open ? 'common.hideDetails' : 'common.details')}
            accessibilityLabel={say('common.details')}
            onPress={() => setOpen(!open)}
          />
        ) : null}
      </View>
      {open && details}
    </View>
  );
}

/**
 * A decision from the supervisor. An approval that can be shown exactly fills fixed slots, in this
 * order: what will happen, what it touches, the exact details, the evidence, and (when the server
 * offers it) how far the approval reaches; then one tap answers. Any other card is its own sentence
 * as sent, its evidence, and its answers. An answer on its way is one line.
 */
export function DecisionCard({
  item,
  task,
  disabled,
  onAnswer,
}: {
  item: InboxItem;
  /** The task the card is about, when this screen has it: its checks are the card's evidence. */
  task?: TaskView | undefined;
  disabled: boolean;
  onAnswer: (optionId: string, text?: string) => void;
}) {
  const [note, setNote] = useState('');
  const { t: say, tx } = useT();
  const card = inboxCardModel(item);
  const held = card.evidence.find((line) => line.kind === 'action');
  const exact = item.kind === 'approval' && !card.cannotApproveHere;
  if (card.answering)
    return (
      <Receipt
        text={tx(card.answering)}
        details={exact ? <Exact text={card.text} held={held} /> : undefined}
      />
    );
  // A finished task reads as a title, how far it was checked, and the outcome; any other wording is
  // shown whole, as the supervisor sent it.
  const finished = finishedParts(item);
  const answer = (optionId: string) => onAnswer(optionId, note.trim() || undefined);
  return (
    <View style={{ gap: 10 }} accessible={false}>
      {finished ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <StatusMark tone="ok" />
            <T kind="heading" selectable style={{ flex: 1 }}>
              {say('decision.finished', { title: finished.title })}
            </T>
          </View>
          <T kind="small">
            {tx(`${finished.check.charAt(0).toUpperCase()}${finished.check.slice(1)}`)}
          </T>
          <T kind="body" selectable>
            {finished.outcome}
          </T>
        </>
      ) : exact ? (
        <>
          <Header text={tx(card.heading)} open={item.state === 'open'} />
          <WillHappen tool={held?.tool ?? heldToolOf(card.text)} />
          <Touches card={card.text} />
          <Exact text={card.text} held={held} />
        </>
      ) : (
        <>
          <Header text={tx(card.heading)} open={item.state === 'open'} />
          <T kind="heading" selectable>
            {card.text}
          </T>
          {held && (
            <Solid>
              <T kind="small">{say('decision.held', { tool: held.tool })}</T>
              <T kind="small" selectable style={mono}>
                {held.args}
              </T>
            </Solid>
          )}
        </>
      )}
      {card.cannotApproveHere && <T kind="muted">{say('decision.cannotShow')}</T>}
      <Evidence lines={card.evidence} task={task} />
      {item.allowText && <Note value={note} onChange={setNote} disabled={disabled} />}
      <Answers options={card.options} disabled={disabled} onAnswer={answer} />
    </View>
  );
}

/**
 * A question the conversation is asking. An approval of a held call fills the same slots as an
 * approval card; any other question is its sentence and its answers. Once answered it is one line.
 */
export function QuestionBlock({
  question,
  answered,
  disabled,
  onAnswer,
}: {
  question: Question;
  answered?: string;
  disabled: boolean;
  onAnswer: (optionId: string, text?: string) => void;
}) {
  const card = questionCardModel(question, answered);
  const [note, setNote] = useState('');
  const { t: say, tx, choice } = useT();
  // A server's fixed choice is in the app's words; any other label is shown as sent, and only the
  // stand-in for a missing one is the app's.
  if (answered) {
    const answeredLabel = question.options.some((option) => option.id === answered)
      ? card.answeredLabel && choice(answered, card.answeredLabel)
      : card.answeredLabel && tx(card.answeredLabel);
    // The exact text stays, and so does the held call it bound (the answered model drops it).
    const asked = questionCardModel(question);
    return (
      <Receipt
        text={say('decision.recorded', { label: answeredLabel ?? '' })}
        details={
          question.reason === 'irreversible' && !asked.cannotApproveHere ? (
            <Exact text={asked.text} held={asked.held} />
          ) : undefined
        }
      />
    );
  }
  const exact = question.reason === 'irreversible' && !card.cannotApproveHere;
  const answer = (optionId: string) => onAnswer(optionId, note.trim() || undefined);
  return (
    <View style={{ gap: 10 }}>
      <Header text={tx(card.heading)} open />
      {exact ? (
        <>
          <WillHappen tool={card.held?.tool ?? heldToolOf(card.text)} note={card.note} />
          <Touches card={card.text} />
          <Exact text={card.text} held={card.held} />
        </>
      ) : (
        <>
          <T kind="heading" selectable>
            {card.text}
          </T>
          {card.cannotApproveHere && <T kind="muted">{say('decision.cannotShow')}</T>}
          {card.note && <T kind="muted">{card.note}</T>}
          {card.held && (
            <Solid>
              <T kind="small">{say('decision.held', { tool: card.held.tool })}</T>
              <T kind="small" selectable style={mono}>
                {card.held.args}
              </T>
            </Solid>
          )}
        </>
      )}
      <Note value={note} onChange={setNote} disabled={disabled} />
      <Answers options={card.options} disabled={disabled} onAnswer={answer} />
    </View>
  );
}
