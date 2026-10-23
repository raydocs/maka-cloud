import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { displayText, failureWords } from '@maka-cloud/client';
import { type ReactNode, useState } from 'react';
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
import { mono, PANEL, radius, ThemeContext, TOUCH, useTheme } from '@/lib/theme';
import { Icon, type IconName } from './Icon';

/**
 * The soft full-bleed background every screen sits on. The sections are a glass pill at the top
 * (`TopBar`), so nothing sits below a screen: every edge is a safe-area edge, on both platforms.
 */
const SCREEN_EDGES: Edge[] = ['top', 'left', 'right', 'bottom'];

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
 * The compact panel: one near-black rounded slab the conversation sits on, in either appearance.
 * Everything inside it reads the panel palette (`PANEL`), so cards, buttons and text follow it.
 */
export function Panel({ children }: { children: ReactNode }) {
  return (
    <ThemeContext.Provider value={PANEL}>
      <View style={[styles.panel, { backgroundColor: PANEL.panel, borderColor: PANEL.cardEdge }]}>
        {children}
      </View>
    </ThemeContext.Provider>
  );
}

/**
 * A translucent glass surface for controls that float over content (the section pill, the round
 * buttons, the message field): Liquid Glass on iOS 26 and later, a blur under the `glass` fill
 * elsewhere. The style sets its shape; children sit on top.
 */
export function Glass({ children, style }: { children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  if (glass)
    return (
      <GlassView colorScheme={t.scheme} style={[styles.glass, style]}>
        {children}
      </GlassView>
    );
  return (
    <View style={[styles.glass, style]}>
      <BlurView
        intensity={30}
        tint={t.scheme === 'dark' ? 'dark' : 'light'}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: t.glass }]} />
      {children}
    </View>
  );
}

/**
 * Where content scrolls under something that floats (the section pill, the composer): it fades
 * out into `color` instead of meeting a hard edge. Drawn over the content, never touchable.
 */
export function Fade({
  edge,
  height,
  color,
  clear,
}: {
  edge: 'top' | 'bottom';
  height: number;
  color: string;
  clear: string;
}) {
  return (
    <LinearGradient
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      colors={edge === 'top' ? [color, color, clear] : [clear, color, color]}
      locations={edge === 'top' ? [0, 0.55, 1] : [0, 0.5, 1]}
      style={[styles.fade, edge === 'top' ? { top: 0 } : { bottom: 0 }, { height }]}
    />
  );
}

/**
 * A frosted card: the system's Liquid Glass on iOS 26 and later, a blur with a translucent fill
 * elsewhere, and a flat fill inside the panel. Anything that holds code or a diff uses `Solid`
 * instead and is never blurred.
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
  if (t.surface === 'panel')
    return (
      <View
        style={[styles.cardBody, { borderColor: t.cardEdge, backgroundColor: t.card }, style]}
        accessibilityLabel={label}
      >
        {children}
      </View>
    );
  if (glass)
    return (
      <GlassView colorScheme={t.scheme} style={body} accessibilityLabel={label}>
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
  body: { fontSize: 16, lineHeight: 24 },
  muted: { fontSize: 15, lineHeight: 22 },
  small: { fontSize: 13, lineHeight: 18 },
  error: { fontSize: 15, lineHeight: 21 },
};

/**
 * A button: filled with ink when it is the recommended answer, outlined otherwise. At least 44 pt
 * tall. `external` adds the arrow of a link that leaves the app.
 */
export function PillButton({
  label,
  onPress,
  primary = false,
  disabled = false,
  external = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  external?: boolean;
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
      <View style={styles.pillRow}>
        <Text style={[styles.pillText, { color: primary ? t.onPillOn : t.ink }]} allowFontScaling>
          {label}
        </Text>
        {external && <Icon name="external" size={15} color={primary ? t.onPillOn : t.ink} />}
      </View>
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
  icon,
  onPress,
  disabled,
}: {
  label: string;
  icon: IconName;
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
      <Icon name={icon} size={20} color={disabled ? t.inkMuted : t.onPillOn} />
    </Pressable>
  );
}

/** A round glass button with an icon, for the corners of a floating bar. At least 44 pt. */
export function GlassButton({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={`button-${label}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.round, { opacity: pressed ? 0.7 : 1 }]}
    >
      <Glass style={[StyleSheet.absoluteFill, { borderRadius: TOUCH / 2 }]} />
      <Icon name={icon} size={20} color={t.ink} />
    </Pressable>
  );
}

/** `**words**` on one line, with no space just inside the marks (as Markdown reads it). */
const BOLD = /\*\*(?=[^\s*])([^*\n]*?[^\s*])\*\*/gu;

/** A message split into plain runs and the `**bold**` lead-ins an answer marks. */
export function boldRuns(text: string): { text: string; bold: boolean }[] {
  const runs: { text: string; bold: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(BOLD)) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index), bold: false });
    runs.push({ text: match[1] ?? '', bold: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), bold: false });
  return runs;
}

/** The words of a message without the `**` marks, as a screen reader should hear them. */
export const withoutMarks = (text: string) => text.replace(BOLD, '$1');

/** Message text with its bold lead-ins drawn bold; anything else is shown exactly as written. */
export function Rich({ text }: { text: string }) {
  const runs = boldRuns(text);
  return (
    <T kind="body" selectable>
      {runs.length === 1 && !runs[0]?.bold
        ? text
        : runs.map((run, i) =>
            run.bold ? (
              // The runs never reorder, so the position is their identity.
              <Text key={i} style={styles.bold}>
                {run.text}
              </Text>
            ) : (
              run.text
            ),
          )}
    </T>
  );
}

/** Rounded tiles two to a row, in reading order; an odd last tile stays half wide. */
export function Tiles({ children }: { children: ReactNode }) {
  return <View style={styles.tiles}>{children}</View>;
}

/** One tile: a small line above it (a date, a name) and a bold title of up to three lines. */
export function Tile({
  over,
  title,
  titleStyle,
  onPress,
  accessibilityLabel,
}: {
  over?: string;
  title: string;
  titleStyle?: StyleProp<TextStyle>;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  const body = (
    <>
      {over ? (
        <T kind="small" numberOfLines={1}>
          {over}
        </T>
      ) : null}
      <T kind="body" style={[styles.bold, titleStyle]} numberOfLines={3}>
        {title}
      </T>
    </>
  );
  const shape = [styles.tile, { backgroundColor: t.chip, borderColor: t.cardEdge }];
  if (!onPress)
    return (
      <View
        style={shape}
        accessible
        accessibilityLabel={accessibilityLabel ?? [over, title].filter(Boolean).join(', ')}
      >
        {body}
      </View>
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      style={({ pressed }) => [...shape, { opacity: pressed ? 0.75 : 1 }]}
    >
      {body}
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

/** Why a task failed, in a plain sentence and a next step; the server's own words behind "Details". */
export function FailureNote({ reason }: { reason: string }) {
  const t = useTheme();
  const words = failureWords(displayText(reason));
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 2 }}>
      <T kind="error">
        {words.sentence} <Text style={{ color: t.ink }}>{words.next}</Text>
      </T>
      {words.detail !== words.sentence && (
        <>
          <QuietButton
            label={open ? 'Hide details' : 'Details'}
            accessibilityLabel="Details"
            onPress={() => setOpen(!open)}
          />
          {open && (
            <T kind="small" selectable style={mono}>
              {words.detail}
            </T>
          )}
        </>
      )}
    </View>
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
  panel: {
    flex: 1,
    marginHorizontal: 8,
    marginBottom: 8,
    borderRadius: radius.panel,
    borderWidth: 1,
    overflow: 'hidden',
  },
  glass: { overflow: 'hidden', borderRadius: radius.pill },
  fade: { position: 'absolute', left: 0, right: 0 },
  cardWrap: { borderRadius: radius.tile, borderWidth: 1, overflow: 'hidden' },
  cardFill: { padding: 16, gap: 10 },
  cardBody: { borderRadius: radius.tile, borderWidth: 1, padding: 16, gap: 10 },
  bold: { fontWeight: '700' },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 },
  tile: {
    width: '48.5%',
    minHeight: 96,
    borderRadius: radius.tile,
    borderWidth: 1,
    padding: 14,
    gap: 4,
  },
  pill: {
    minHeight: TOUCH,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: { fontSize: 16, fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    maxWidth: '100%',
  },
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
    borderRadius: radius.card,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
  },
});
