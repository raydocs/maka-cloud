import { BlurView } from 'expo-blur';
import {
  GlassContainer,
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { displayText, failureWords } from '@maka-cloud/client';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  Animated,
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
import { useReduceMotion, useReduceTransparency } from '@/lib/appearance';
import { type Language, useT } from '@/lib/i18n';
import { mono, radius, TOUCH, useTheme } from '@/lib/theme';
import { Icon, type IconName } from './Icon';

/**
 * The soft full-bleed background every screen sits on. Nothing sits below the screen (no tab bar),
 * so on every platform it keeps clear of all four edges: the home indicator, Android's navigation.
 */
const SCREEN_EDGES: Edge[] = ['top', 'left', 'right', 'bottom'];

export function Screen({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <LinearGradient colors={[t.bgTop, t.bgBottom]} style={styles.fill}>
      <SafeAreaView testID="screen" style={styles.fill} edges={SCREEN_EDGES}>
        {children}
      </SafeAreaView>
    </LinearGradient>
  );
}

/** The system's Liquid Glass: iOS 26 and later (and never a beta without the API). */
const glass = Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

/** Whether this phone draws Liquid Glass and the person has not asked for less transparency. */
function useGlass(): boolean {
  return glass && !useReduceTransparency();
}

/** The height of the floating top bar (search, the section pill, Me); content scrolls under it. */
export const TOP_BAR = 60;

/**
 * A translucent glass surface for controls that float over content (the round buttons, the message
 * field): Liquid Glass on iOS 26 and later, `interactive` when it is tapped; a blur under the `glass`
 * fill on Android, older iOS and the web. With Reduce Transparency on it is a solid fill with an edge.
 * The style sets its shape; children sit on top.
 */
export function Glass({
  children,
  style,
  interactive = false,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  interactive?: boolean;
}) {
  const t = useTheme();
  const liquid = useGlass();
  const reduce = useReduceTransparency();
  if (reduce)
    return (
      <View
        testID="glass-solid"
        style={[
          styles.glass,
          styles.edge,
          { backgroundColor: t.solid, borderColor: t.solidLine },
          style,
        ]}
      >
        {children}
      </View>
    );
  if (liquid)
    return (
      <GlassView colorScheme={t.scheme} isInteractive={interactive} style={[styles.glass, style]}>
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
 * Glass shapes that sit close together (the composer's button and field): on Liquid Glass they share
 * one sampling region and blend as they near each other; elsewhere a plain view.
 */
export function GlassGroup({
  children,
  style,
  spacing = 8,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  spacing?: number;
}) {
  if (useGlass())
    return (
      <GlassContainer spacing={spacing} style={style}>
        {children}
      </GlassContainer>
    );
  return <View style={style}>{children}</View>;
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
      locations={edge === 'top' ? [0, 0.65, 1] : [0, 0.5, 1]}
      style={[styles.fade, edge === 'top' ? { top: 0 } : { bottom: 0 }, { height }]}
    />
  );
}

/**
 * A frosted card: the system's Liquid Glass on iOS 26 and later, a blur with a translucent fill
 * elsewhere; with Reduce Transparency on, a solid fill. Anything that holds code or a diff uses
 * `Solid` instead and is never blurred.
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
  const liquid = useGlass();
  const reduce = useReduceTransparency();
  const body = [styles.cardBody, { borderColor: t.cardEdge }, style];
  if (reduce)
    return (
      <View
        style={[styles.cardBody, { borderColor: t.solidLine, backgroundColor: t.solid }, style]}
        accessibilityLabel={label}
      >
        {children}
      </View>
    );
  if (liquid)
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
  testID?: string;
}) {
  const t = useTheme();
  const { lang } = useT();
  const color =
    kind === 'muted' || kind === 'small' ? t.inkMuted : kind === 'error' ? t.bad : t.ink;
  return (
    <Text
      style={[TEXT[lang][kind], { color }, style]}
      allowFontScaling
      // Break lines so a paragraph does not end on one lone character or word.
      lineBreakStrategyIOS="push-out"
      textBreakStrategy="balanced"
      {...(kind === 'title' || kind === 'heading' ? { accessibilityRole: 'header' as const } : {})}
      {...(kind === 'error' ? { accessibilityRole: 'alert' as const } : {})}
      {...rest}
    >
      {children}
    </Text>
  );
}

/**
 * Five sizes and two weights, in every language: a title (22), a heading (17), body text (16),
 * secondary text (14; muted and error lines) and captions (12). Titles and headings are semibold, so a
 * card has one semibold line and the rest is regular. The system face throughout (PingFang SC or TC
 * for Chinese on iOS); Chinese gets more room between lines, about 1.6 times the size, and no
 * language adds letter spacing.
 */
const CJK: Record<TextKind, TextStyle> = {
  title: { fontSize: 22, lineHeight: 32, fontWeight: '600' },
  heading: { fontSize: 17, lineHeight: 26, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 26 },
  muted: { fontSize: 14, lineHeight: 22 },
  small: { fontSize: 12, lineHeight: 18 },
  error: { fontSize: 14, lineHeight: 22 },
};

const TEXT: Record<Language, Record<TextKind, TextStyle>> = {
  en: {
    title: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
    heading: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
    body: { fontSize: 16, lineHeight: 24 },
    muted: { fontSize: 14, lineHeight: 20 },
    small: { fontSize: 12, lineHeight: 16 },
    error: { fontSize: 14, lineHeight: 20 },
  },
  'zh-Hans': CJK,
  'zh-Hant': CJK,
};

/** What a press feels like: a light tap, or the warning buzz of an answer that stops something. */
export type HapticKind = 'light' | 'warning';

function buzz(kind: HapticKind) {
  const done =
    kind === 'warning'
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
      : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  void done.catch(() => {});
}

/**
 * A button: filled with ink when it is the recommended answer, outlined otherwise. At least 44 pt
 * tall. `compact` sizes it to its label instead of the full width (the answers on a card); its touch
 * area still reaches 44 pt. A disabled button is a faint outline, not a grey slab. `external` adds the
 * arrow of a link that leaves the app.
 */
export function PillButton({
  label,
  onPress,
  primary = false,
  disabled = false,
  external = false,
  compact = false,
  haptic = 'light',
  accessibilityLabel,
  id,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  external?: boolean;
  compact?: boolean;
  haptic?: HapticKind;
  accessibilityLabel?: string;
  /** A fixed name for the device tests (`button-<id>`), the same in every language. */
  id?: string;
}) {
  const t = useTheme();
  const filled = primary && !disabled;
  const ink = filled ? t.onPillOn : disabled ? t.inkMuted : t.ink;
  return (
    <Pressable
      testID={`button-${id ?? label}`}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={compact ? 4 : undefined}
      onPress={() => {
        buzz(haptic);
        onPress();
      }}
      style={({ pressed }) => [
        styles.pill,
        compact && styles.pillCompact,
        filled
          ? { backgroundColor: t.pillOn, borderColor: t.pillOn }
          : disabled
            ? { backgroundColor: 'transparent', borderColor: t.cardEdge }
            : { backgroundColor: t.chip, borderColor: t.cardEdge },
        { opacity: pressed ? 0.8 : 1 },
      ]}
    >
      <View style={styles.pillRow}>
        <Text
          style={[styles.pillText, compact && styles.pillTextCompact, { color: ink }]}
          allowFontScaling
        >
          {label}
        </Text>
        {external && <Icon name="external" color={ink} />}
      </View>
    </Pressable>
  );
}

/** Buttons side by side, each as wide as its label, wrapping to a new row when they run out of room. */
export function ButtonRow({ children }: { children: ReactNode }) {
  return <View style={styles.buttonRow}>{children}</View>;
}

/**
 * A line that is still going (the agent working, the current step): a short thin rule under it
 * breathes slowly. The text itself stays fully opaque, so it keeps its contrast. No rule under
 * Reduce Motion.
 */
export function Shimmer({ children }: { children: ReactNode }) {
  const reduce = useReduceMotion();
  const t = useTheme();
  const opacity = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.15, duration: 900, useNativeDriver: NATIVE }),
        Animated.timing(opacity, { toValue: 0.6, duration: 900, useNativeDriver: NATIVE }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, opacity]);
  return (
    <View style={{ gap: 3 }}>
      {children}
      {!reduce && (
        <Animated.View
          testID="shimmer"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ width: 28, height: 2, borderRadius: 1, backgroundColor: t.inkMuted, opacity }}
        />
      )}
    </View>
  );
}

/**
 * Something new arriving (a message, a card): it rises a few points into place on a soft spring.
 * Only when `enter` is set (things already there when the screen opens just show), and never under
 * Reduce Motion.
 */
export function Appear({ enter, children }: { enter: boolean; children: ReactNode }) {
  const reduce = useReduceMotion();
  const still = reduce || !enter;
  const progress = useRef(new Animated.Value(still ? 1 : 0)).current;
  useEffect(() => {
    if (still) {
      progress.setValue(1);
      return;
    }
    const spring = Animated.spring(progress, {
      toValue: 1,
      damping: 18,
      stiffness: 160,
      mass: 1,
      useNativeDriver: NATIVE,
    });
    spring.start();
    return () => spring.stop();
  }, [still, progress]);
  if (still) return <>{children}</>;
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [10, 0] });
  return (
    <Animated.View style={{ opacity: progress, transform: [{ translateY }] }}>
      {children}
    </Animated.View>
  );
}

/** Native-driven animation where there is a native side; the web preview animates in JavaScript. */
const NATIVE = Platform.OS !== 'web';

/** A quiet word that does something ("Add a note"): muted, 44 pt tall. */
export function QuietButton({
  label,
  onPress,
  accessibilityLabel,
  disabled = false,
  id,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
  /** A fixed name for the device tests (`button-<id>`), the same in every language. */
  id?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      {...(id ? { testID: `button-${id}` } : {})}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.quiet, { opacity: disabled ? 0.5 : pressed ? 0.6 : 1 }]}
    >
      <Text style={{ color: t.inkMuted, fontSize: 14 }} allowFontScaling>
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
  id,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  disabled: boolean;
  /** A fixed name for the device tests (`button-<id>`), the same in every language. */
  id?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={`button-${id ?? label}`}
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
      <Icon name={icon} color={disabled ? t.inkMuted : t.onPillOn} />
    </Pressable>
  );
}

/** A round glass button with an icon, for the corners of a floating bar. At least 44 pt. */
export function GlassButton({
  label,
  icon,
  onPress,
  id,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  /** A fixed name for the device tests (`button-<id>`), the same in every language. */
  id?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={`button-${id ?? label}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.round, { opacity: pressed ? 0.7 : 1 }]}
    >
      <Glass interactive style={[StyleSheet.absoluteFill, { borderRadius: TOUCH / 2 }]} />
      <Icon name={icon} color={t.ink} />
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

/** One tile: a small line above it (a date, a name) and a title of up to three lines. */
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
      <T kind="body" style={titleStyle} numberOfLines={3}>
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
      <Text style={{ color: t.ink, fontSize: 12 }} allowFontScaling>
        {children}
      </Text>
    </View>
  );
}

/**
 * A task's or a card's state as a small mark, in two tones plus one colour: the attention colour
 * only for what needs the person; done is a filled ink dot, failed an ink ring with a dot, anything
 * else (stopped, at rest) a faint ring.
 */
export function StatusMark({ tone }: { tone: 'ok' | 'attention' | 'bad' | 'idle' }) {
  const t = useTheme();
  const shape =
    tone === 'attention'
      ? { backgroundColor: t.warn }
      : tone === 'ok'
        ? { backgroundColor: t.ink }
        : tone === 'bad'
          ? { borderWidth: 3, borderColor: t.ink }
          : { borderWidth: 1.5, borderColor: t.inkMuted };
  return (
    <View
      testID={`mark-${tone}`}
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[styles.mark, shape]}
    />
  );
}

/**
 * Our own small "thinking" mark while the agent works: a dot whose halo slowly widens and fades, like
 * a breath. Under Reduce Motion it is the still dot.
 */
export function Thinking() {
  const t = useTheme();
  const reduce = useReduceMotion();
  const breath = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) {
      breath.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(breath, { toValue: 1, duration: 1600, useNativeDriver: NATIVE }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, breath]);
  return (
    <View
      testID="thinking"
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={styles.thinking}
    >
      {!reduce && (
        <Animated.View
          style={[
            styles.thinkingHalo,
            {
              borderColor: t.ink,
              opacity: breath.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
              transform: [
                { scale: breath.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.6] }) },
              ],
            },
          ]}
        />
      )}
      <View style={[styles.thinkingDot, { backgroundColor: t.ink }]} />
    </View>
  );
}

/** Why a task failed, in a plain sentence and a next step; the server's own words behind "Details". */
export function FailureNote({ reason }: { reason: string }) {
  const t = useTheme();
  const { t: say, tx } = useT();
  const words = failureWords(displayText(reason));
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 2 }}>
      <T kind="error">
        {tx(words.sentence)} <Text style={{ color: t.ink }}>{tx(words.next)}</Text>
      </T>
      {words.detail !== words.sentence && (
        <>
          <QuietButton
            label={say(open ? 'common.hideDetails' : 'common.details')}
            accessibilityLabel={say('common.details')}
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
/** `id` is a fixed name for the device tests (`field-<id>`), the same in every language. */
export function Field(props: TextInputProps & { label: string; showLabel?: boolean; id?: string }) {
  const t = useTheme();
  const { label, showLabel = false, style, id, ...rest } = props;
  const input = (
    <TextInput
      testID={`field-${id ?? label}`}
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
      <T kind="small">{label}</T>
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

  glass: { overflow: 'hidden', borderRadius: radius.pill },
  edge: { borderWidth: 1 },
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
  pillCompact: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    minHeight: 40,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  pillText: { fontSize: 16, fontWeight: '500', textAlign: 'center', flexShrink: 1 },
  pillTextCompact: { fontSize: 15 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
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
  thinking: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
  thinkingHalo: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
  },
  thinkingDot: { width: 7, height: 7, borderRadius: 3.5 },
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
