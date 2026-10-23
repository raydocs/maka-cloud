import {
  displayText,
  type EvidenceLine,
  finishedParts,
  type InboxItem,
  inboxCardModel,
  type Question,
  questionCardModel,
} from '@maka-cloud/client';
import { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Field, PillButton, QuietButton, Solid, StatusMark, T } from './ui';
import { useT } from '@/lib/i18n';
import { mono, useTheme } from '@/lib/theme';
import { Icon } from './Icon';

function Evidence({ line }: { line: EvidenceLine }) {
  const t = useTheme();
  const { t: say, tx } = useT();
  if (line.kind === 'artifact') return <T kind="small">{tx(line.text)}</T>;
  if (line.kind === 'action')
    return (
      <Solid>
        <T kind="small">{say('decision.held', { tool: line.tool })}</T>
        <T kind="small" selectable style={mono}>
          {line.args}
        </T>
      </Solid>
    );
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
      <Icon name="external" size={13} color={t.inkMuted} />
    </Pressable>
  ) : (
    <T kind="small">{line.label}</T>
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

/** A decision from the supervisor: its own sentence as sent, then one tap per option. */
export function DecisionCard({
  item,
  disabled,
  onAnswer,
}: {
  item: InboxItem;
  disabled: boolean;
  onAnswer: (optionId: string, text?: string) => void;
}) {
  const [note, setNote] = useState('');
  const { t: say, tx } = useT();
  const card = inboxCardModel(item);
  // A finished task reads as a title, how far it was checked, and the outcome; any other wording is
  // shown whole, as the supervisor sent it.
  const finished = finishedParts(item);
  return (
    <View style={{ gap: 8 }} accessible={false}>
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
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <StatusMark tone={item.state === 'open' ? 'attention' : 'ok'} />
            <T kind="small">{tx(card.heading)}</T>
          </View>
          <T kind="heading" selectable>
            {card.text}
          </T>
        </>
      )}
      {card.cannotApproveHere && <T kind="muted">{say('decision.cannotShow')}</T>}
      {card.evidence.map((line, index) => (
        <Evidence key={`${item.itemId}-${index}`} line={line} />
      ))}
      {card.answering ? (
        <T kind="muted" accessibilityRole="text">
          {tx(card.answering)}
        </T>
      ) : (
        <>
          {item.allowText && <Note value={note} onChange={setNote} disabled={disabled} />}
          <View style={{ gap: 8 }}>
            {card.options.map((option) => (
              <PillButton
                key={option.id}
                label={displayText(option.label)}
                primary={option.recommended}
                disabled={disabled}
                onPress={() => onAnswer(option.id, note.trim() || undefined)}
              />
            ))}
          </View>
        </>
      )}
    </View>
  );
}

/** A question the conversation is asking: pick an answer, optionally add context, send. */
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
  const { t: say, tx } = useT();
  // The option's own label is shown as sent; only the stand-in for a missing one is the app's.
  const answeredLabel =
    card.answeredLabel === 'Selected option' ? tx(card.answeredLabel) : card.answeredLabel;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <StatusMark tone={answered ? 'ok' : 'attention'} />
        <T kind="small">{tx(card.heading)}</T>
      </View>
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
      {answered ? (
        <T kind="muted">{say('decision.recorded', { label: answeredLabel ?? '' })}</T>
      ) : (
        <>
          <Note value={note} onChange={setNote} disabled={disabled} />
          <View style={{ gap: 8 }}>
            {card.options.map((option) => (
              <PillButton
                key={option.id}
                label={option.label}
                primary={option.recommended}
                disabled={disabled}
                onPress={() => onAnswer(option.id, note.trim() || undefined)}
              />
            ))}
          </View>
        </>
      )}
    </View>
  );
}
