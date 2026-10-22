import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import {
  Platform,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { type Edge, SafeAreaView } from 'react-native-safe-area-context';
import { radius, TOUCH, useTheme } from '@/lib/theme';

/**
 * The soft full-bleed background every screen sits on. On iOS the tab bar floats over the screen, so
 * its height is part of the bottom inset (the chat box sat on top of it); Android lays the bar out
 * below the screen already.
 */
const SCREEN_EDGES: Edge[] =
  Platform.OS === 'ios' ? ['top', 'left', 'right', 'bottom'] : ['top', 'left', 'right'];

export function Screen({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <LinearGradient colors={[t.bgTop, t.bgBottom]} style={styles.fill}>
      <SafeAreaView style={styles.fill} edges={SCREEN_EDGES}>
        {children}
      </SafeAreaView>
    </LinearGradient>
  );
}

const glass = Platform.OS === 'ios' && isLiquidGlassAvailable();

/**
 * A frosted card: the system's Liquid Glass on iOS 26 and later, a blur with a translucent fill
 * elsewhere. Anything that holds code or a diff uses `Solid` instead and is never blurred.
 * The label names the card for tests and the web preview; the card is never one accessibility
 * element itself, or iOS would fold the fields and buttons inside it into it.
 */
export function Card({
  children,
  label,
  style,
}: {
  children: ReactNode;
  label?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const body = [styles.cardBody, { borderColor: t.cardEdge }, style];
  if (glass)
    return (
      <GlassView style={body} accessibilityLabel={label}>
        {children}
      </GlassView>
    );
  return (
    <View style={[styles.cardWrap, { borderColor: t.cardEdge }]} accessibilityLabel={label}>
      <BlurView
        intensity={40}
        tint={t.scheme === 'dark' ? 'dark' : 'light'}
        style={StyleSheet.absoluteFill}
      />
      <View style={[styles.cardFill, { backgroundColor: t.card }, style]}>{children}</View>
    </View>
  );
}

/** Opaque and dense, for anything read as code, a diff or test output. Never blurred or tinted. */
export function Solid({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View
      style={[
        { backgroundColor: t.solid, borderColor: t.solidLine, borderWidth: 1, padding: 12 },
        { borderRadius: radius.small },
        style,
      ]}
    >
      {children}
    </View>
  );
}

type TextKind = 'title' | 'heading' | 'body' | 'muted' | 'small' | 'error';

export function T({
  kind = 'body',
  children,
  style,
  ...rest
}: {
  kind?: TextKind;
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  selectable?: boolean;
  numberOfLines?: number;
  accessibilityRole?: 'header' | 'text' | 'alert' | 'link';
  onPress?: () => void;
}) {
  const t = useTheme();
  const color =
    kind === 'muted' || kind === 'small' ? t.inkMuted : kind === 'error' ? t.bad : t.ink;
  return (
    <Text
      style={[TEXT[kind], { color }, style]}
      allowFontScaling
      {...(kind === 'title' || kind === 'heading' ? { accessibilityRole: 'header' as const } : {})}
      {...(kind === 'error' ? { accessibilityRole: 'alert' as const } : {})}
      {...rest}
    >
      {children}
    </Text>
  );
}

const TEXT: Record<TextKind, TextStyle> = {
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22 },
  muted: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  error: { fontSize: 15, lineHeight: 21 },
};

/** A button: filled with ink when it is the recommended answer, outlined otherwise. At least 44 pt tall. */
export function PillButton({
  label,
  onPress,
  primary = false,
  disabled = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={`button-${label}`}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        styles.pill,
        primary
          ? { backgroundColor: t.pillOn, borderColor: t.pillOn }
          : { backgroundColor: t.chip, borderColor: t.cardEdge },
        { opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={[styles.pillText, { color: primary ? t.onPillOn : t.ink }]} allowFontScaling>
        {label}
      </Text>
    </Pressable>
  );
}

/** A quiet word that does something ("Add a note"): muted, 44 pt tall. */
export function QuietButton({
  label,
  onPress,
  accessibilityLabel,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.quiet, { opacity: disabled ? 0.5 : pressed ? 0.6 : 1 }]}
    >
      <Text style={{ color: t.inkMuted, fontSize: 15 }} allowFontScaling>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A small round send button next to a field. It is filled with ink when there is something to send;
 * when there is not, it is an outlined ring in the muted ink (readable, but plainly at rest). Actions
 * are ink, as on the web; the accent is kept for what needs the person.
 */
export function RoundButton({
  label,
  glyph,
  onPress,
  disabled,
}: {
  label: string;
  glyph: string;
  onPress: () => void;
  disabled: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={`button-${label}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onPress();
      }}
      style={[
        styles.round,
        disabled
          ? { backgroundColor: t.chip, borderColor: t.inkMuted, borderWidth: 1.5 }
          : { backgroundColor: t.pillOn, borderColor: t.pillOn, borderWidth: 1.5 },
      ]}
    >
      <Text
        style={{ color: disabled ? t.inkMuted : t.onPillOn, fontSize: 20, fontWeight: '700' }}
        allowFontScaling={false}
      >
        {glyph}
      </Text>
    </Pressable>
  );
}

export function Chip({ children }: { children: string }) {
  const t = useTheme();
  return (
    <View style={[styles.chip, { backgroundColor: t.chip, borderColor: t.cardEdge }]}>
      <Text style={{ color: t.ink, fontSize: 13, fontWeight: '600' }} allowFontScaling>
        {children}
      </Text>
    </View>
  );
}

export function StatusMark({ tone }: { tone: 'ok' | 'attention' | 'bad' | 'idle' }) {
  const t = useTheme();
  const color =
    tone === 'ok' ? t.ok : tone === 'bad' ? t.bad : tone === 'attention' ? t.warn : t.inkMuted;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[styles.mark, { backgroundColor: color }]}
    />
  );
}

/** A text field. `showLabel` puts its name above it (a placeholder alone disappears once typing starts). */
export function Field(props: TextInputProps & { label: string; showLabel?: boolean }) {
  const t = useTheme();
  const { label, showLabel = false, style, ...rest } = props;
  const input = (
    <TextInput
      testID={`field-${label}`}
      accessibilityLabel={label}
      placeholderTextColor={t.inkMuted}
      allowFontScaling
      style={[
        styles.field,
        { color: t.ink, backgroundColor: t.chip, borderColor: t.cardEdge },
        style,
      ]}
      {...rest}
    />
  );
  if (!showLabel) return input;
  return (
    <View style={{ gap: 6 }}>
      <T kind="small" style={{ fontWeight: '600' }}>
        {label}
      </T>
      {input}
    </View>
  );
}

/** A grey bar standing in for a line of text that has not arrived yet. */
export function SkeletonLine({ width = '100%' }: { width?: ViewStyle['width'] }) {
  const t = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ height: 14, width, borderRadius: 7, backgroundColor: t.chip }}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  cardWrap: { borderRadius: radius.card, borderWidth: 1, overflow: 'hidden' },
  cardFill: { padding: 16, gap: 10 },
  cardBody: { borderRadius: radius.card, borderWidth: 1, padding: 16, gap: 10 },
  pill: {
    minHeight: TOUCH,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  round: {
    width: TOUCH,
    height: TOUCH,
    borderRadius: TOUCH / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chip: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  mark: { width: 10, height: 10, borderRadius: 5 },
  quiet: { minHeight: TOUCH, justifyContent: 'center', alignSelf: 'flex-start' },
  field: {
    minHeight: TOUCH,
    borderRadius: radius.small,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
  },
});
