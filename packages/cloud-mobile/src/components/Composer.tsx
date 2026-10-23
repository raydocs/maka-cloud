import { displayText } from '@maka-cloud/client';
import { type ReactNode, useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import { useT } from '@/lib/i18n';
import { useWorkspace } from '@/lib/session';
import { clearOf, radius, useTheme } from '@/lib/theme';
import {
  Card,
  Fade,
  Field,
  Glass,
  GlassButton,
  GlassGroup,
  PillButton,
  RoundButton,
  T,
  TOP_BAR,
} from './ui';

/**
 * The floating composer every section shares: a round glass "+" (a new conversation, or another
 * one) and the glass message field with its send button, blending as one control. Each section says
 * what sending does; the fixed ids keep the device tests working in any language.
 */
export function Composer({
  draft,
  onDraft,
  sending,
  disabled,
  onSend,
  onPlus,
  fieldId = 'Keep the conversation going',
  fieldLabel,
  placeholder,
  sendId = 'Send message',
  sendLabel,
  sendingId = 'Sending…',
  sendingLabel,
}: {
  draft: string;
  onDraft: (text: string) => void;
  sending: boolean;
  disabled: boolean;
  onSend: () => void;
  onPlus?: () => void;
  fieldId?: string;
  fieldLabel?: string;
  placeholder?: string;
  sendId?: string;
  sendLabel?: string;
  sendingId?: string;
  sendingLabel?: string;
}) {
  const { t: say } = useT();
  return (
    <GlassGroup style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
      {onPlus && (
        <GlassButton label={say('chat.more')} id="Conversations" icon="plus" onPress={onPlus} />
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
            label={fieldLabel ?? say('chat.field')}
            id={fieldId}
            placeholder={placeholder ?? say('chat.placeholder')}
            multiline
            maxLength={16000}
            value={draft}
            onChangeText={(text) => onDraft(displayText(text))}
            style={{ backgroundColor: 'transparent', borderWidth: 0, maxHeight: 140 }}
          />
        </View>
        <RoundButton
          label={sending ? (sendingLabel ?? say('chat.sending')) : (sendLabel ?? say('chat.send'))}
          id={sending ? sendingId : sendId}
          icon="send"
          disabled={disabled || !draft.trim()}
          onPress={onSend}
        />
      </Glass>
    </GlassGroup>
  );
}

/**
 * The bottom of a section: content scrolls on under a soft fade into the floating composer (and any
 * line above it). Reports its height so the content can leave room for it.
 */
export function Dock({
  children,
  onHeight,
  height,
}: {
  children: ReactNode;
  onHeight: (height: number) => void;
  height: number;
}) {
  const t = useTheme();
  return (
    <>
      <Fade edge="bottom" height={height + 36} color={t.bgBottom} clear={clearOf(t.bgBottom)} />
      <View
        onLayout={(event) => onHeight(Math.ceil(event.nativeEvent.layout.height))}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 12, gap: 8 }}
      >
        {children}
      </View>
    </>
  );
}

/** The fade under the floating top bar, in the sky's top colour. */
export function TopFade() {
  const t = useTheme();
  return <Fade edge="top" height={TOP_FADE} color={t.bgTop} clear={clearOf(t.bgTop)} />;
}

// Solid behind the bar (TOP_BAR), then fading out below it.
const TOP_FADE = TOP_BAR + 32;

/**
 * What "+" opens: a new conversation first, then the conversations, newest first, the open one
 * filled. An opaque sheet of its own, so it reads on the dimmed screen.
 */
export function ConversationSheet({
  visible,
  onClose,
  onChosen,
}: {
  visible: boolean;
  onClose: () => void;
  /** After a choice (the new conversation included): for example, show Chat. */
  onChosen?: () => void;
}) {
  const { conversations, chosen, open } = useWorkspace();
  const theme = useTheme();
  const { t: say } = useT();
  const pick = (conversationId: string) => {
    // No conversation chosen is the empty Chat, where the first message starts one.
    open(conversationId);
    onClose();
    onChosen?.();
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
        <Card
          label={say('chat.conversations')}
          style={{
            backgroundColor: theme.solid,
            margin: 8,
            marginBottom: 24,
            borderRadius: radius.panel,
          }}
        >
          <T kind="heading">{say('chat.conversations')}</T>
          <PillButton label={say('chat.new')} id="New conversation" onPress={() => pick('')} />
          <ScrollView style={{ maxHeight: 340 }} contentContainerStyle={{ gap: 8 }}>
            {[...conversations].reverse().map((c) => (
              <PillButton
                key={c.conversationId}
                label={c.title ? displayText(c.title) : say('common.untitled')}
                primary={c.conversationId === chosen}
                onPress={() => pick(c.conversationId)}
              />
            ))}
          </ScrollView>
          <PillButton label={say('common.close')} id="Close" onPress={onClose} />
        </Card>
      </View>
    </Modal>
  );
}

/** The sheet and the "+" that opens it. */
export function useConversationSheet(onChosen?: () => void) {
  const [visible, setVisible] = useState(false);
  return {
    openSheet: () => setVisible(true),
    sheet: (
      <ConversationSheet
        visible={visible}
        onClose={() => setVisible(false)}
        {...(onChosen ? { onChosen } : {})}
      />
    ),
  };
}
