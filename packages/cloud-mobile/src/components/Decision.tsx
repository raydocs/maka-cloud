import {
  displayText,
  type EvidenceLine,
  type InboxItem,
  inboxCardModel,
  type Question,
  questionCardModel,
} from '@maka-cloud/client';
import { useState } from 'react';
import { Linking, View } from 'react-native';
import { Field, PillButton, Solid, StatusMark, T } from './ui';
import { mono } from '@/lib/theme';

function Evidence({ line }: { line: EvidenceLine }) {
  if (line.kind === 'artifact') return <T kind="small">{line.text}</T>;
  if (line.kind === 'action')
    return (
      <Solid>
        <T kind="small">Held until you answer: {line.tool}</T>
        <T kind="small" selectable style={mono}>
          {line.args}
        </T>
      </Solid>
    );
  const href = line.href;
  return href ? (
    <T
      kind="small"
      accessibilityRole="link"
      style={{ textDecorationLine: 'underline' }}
      onPress={() => void Linking.openURL(href)}
    >
      {line.label} ↗
    </T>
  ) : (
    <T kind="small">{line.label}</T>
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
  const card = inboxCardModel(item);
  return (
    <View style={{ gap: 8 }} accessible={false}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <StatusMark tone={item.state === 'open' ? 'attention' : 'ok'} />
        <T kind="small">{card.heading}</T>
      </View>
      <T kind="heading" selectable>
        {card.text}
      </T>
      {card.cannotApproveHere && (
        <T kind="muted">This card cannot be shown exactly, so it cannot be approved here.</T>
      )}
      {card.evidence.map((line, index) => (
        <Evidence key={`${item.itemId}-${index}`} line={line} />
      ))}
      {card.answering ? (
        <T kind="muted" accessibilityRole="text">
          {card.answering}
        </T>
      ) : (
        <>
          {item.allowText && (
            <Field
              label="Additional context (optional)"
              placeholder="Additional context (optional)"
              multiline
              maxLength={4000}
              value={note}
              onChangeText={(text) => setNote(displayText(text))}
              editable={!disabled}
            />
          )}
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
          {card.hasRecommended && <T kind="small">The filled button is the recommended answer.</T>}
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
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <StatusMark tone={answered ? 'ok' : 'attention'} />
        <T kind="small">{card.heading}</T>
      </View>
      <T kind="heading" selectable>
        {card.text}
      </T>
      {card.cannotApproveHere && (
        <T kind="muted">This card cannot be shown exactly, so it cannot be approved here.</T>
      )}
      {card.note && <T kind="muted">{card.note}</T>}
      {card.held && (
        <Solid>
          <T kind="small">Held until you answer: {card.held.tool}</T>
          <T kind="small" selectable style={mono}>
            {card.held.args}
          </T>
        </Solid>
      )}
      {answered ? (
        <T kind="muted">Answer recorded: {card.answeredLabel}</T>
      ) : (
        <>
          <Field
            label="Additional context (optional)"
            placeholder="Additional context (optional)"
            multiline
            maxLength={4000}
            value={note}
            onChangeText={(text) => setNote(displayText(text))}
            editable={!disabled}
          />
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
