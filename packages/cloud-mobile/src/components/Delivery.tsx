import {
  type ArtifactListing,
  type CloudClient,
  type DeliveryModel,
  type DeliveryView,
  deliveryModel,
  displayText,
  isDiffListing,
  LABEL_WORDS,
  loadSources,
  publicLink,
  type SourceListing,
  type SourcePreview,
  stackOf,
  type TaskView,
} from '@maka-cloud/client';
import { useCallback, useEffect, useState } from 'react';
import { Image, Linking, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useT } from '@/lib/i18n';
import { useBlobUri, usePicture } from '@/lib/picture';
import { mono, radius, TOUCH, useTheme } from '@/lib/theme';
import { Icon } from './Icon';
import { ButtonRow, Card, PillButton, Solid, StatusMark, T } from './ui';

const MONO = Platform.OS === 'ios' ? mono.fontFamily : 'monospace';

const DIFF_LINES_SHOWN = 400;
/** The most lines ever drawn; a diff beyond this is read on the web. */
const DIFF_LINES_MAX = 5000;

/** A diff, line by line, on an opaque page: added lines green, removed lines red. A very long one is cut short. */
export function DiffLines({ text }: { text: string }) {
  const t = useTheme();
  const { t: say } = useT();
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const shown = lines.slice(0, all ? DIFF_LINES_MAX : DIFF_LINES_SHOWN);
  return (
    <Solid>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          {shown.map((line, i) => (
            <Text
              // The text never reorders, so the line number is its identity.
              key={i}
              style={{
                fontFamily: MONO,
                fontSize: 13,
                lineHeight: 18,
                color: line.startsWith('+') ? t.ok : line.startsWith('-') ? t.bad : t.solidInk,
              }}
            >
              {displayText(line) || ' '}
            </Text>
          ))}
        </View>
      </ScrollView>
      {lines.length > shown.length && !all && (
        <PillButton
          label={say('delivery.showLines', {
            shown: Math.min(lines.length, DIFF_LINES_MAX),
            total: lines.length,
          })}
          onPress={() => setAll(true)}
        />
      )}
      {all && lines.length > DIFF_LINES_MAX && (
        <T kind="small">
          {say('delivery.firstLines', { shown: DIFF_LINES_MAX, total: lines.length })}
        </T>
      )}
    </Solid>
  );
}

const REPORT_CHARS = 20_000;
/** The most characters ever drawn; a report beyond this is read on the web. */
const REPORT_CHARS_MAX = 200_000;

/** A report left by the task, as inert text on an opaque page; a very long one is cut short. */
export function Report({ text }: { text: string }) {
  const t = useTheme();
  const { t: say } = useT();
  const [all, setAll] = useState(false);
  const shown = text.slice(0, all ? REPORT_CHARS_MAX : REPORT_CHARS);
  return (
    <Solid>
      <T kind="body" selectable style={{ color: t.solidInk }}>
        {displayText(shown)}
      </T>
      {shown.length < text.length && !all && (
        <PillButton label={say('common.showMore')} id="Show more" onPress={() => setAll(true)} />
      )}
      {all && text.length > REPORT_CHARS_MAX && <T kind="small">{say('delivery.reportCut')}</T>}
    </Solid>
  );
}

/** Opens a link the server called public, in the system browser. */
export function openLink(url: string) {
  void Linking.openURL(url).catch(() => {});
}

/** A picture or diff, large, over the screen; the way back is always on it. */
export function Viewer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useTheme();
  const { t: say } = useT();
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      {/* A modal is its own native window: it needs its own insets, or the header sits under the status bar. */}
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: t.solid }}>
          <View
            style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12 }}
            accessibilityLabel={say('delivery.viewer', { title })}
          >
            <T kind="heading" style={{ flex: 1 }} numberOfLines={1}>
              {title}
            </T>
            <PillButton label={say('common.close')} id="Close" onPress={onClose} />
          </View>
          <ScrollView contentContainerStyle={{ padding: 12 }}>{children}</ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

function ViewerPicture({ blob, title }: { blob: Blob; title: string }) {
  const uri = useBlobUri(blob);
  return uri ? (
    <Image
      source={{ uri }}
      accessibilityLabel={title}
      resizeMode="contain"
      resizeMethod="resize"
      style={{ width: '100%', aspectRatio: 1, borderRadius: radius.small }}
    />
  ) : null;
}

interface Opened {
  kind: 'image' | 'diff' | 'text';
  title: string;
  blob?: Blob;
  text?: string;
}

/**
 * A file the task made, quietly: one line, a small file icon and its name. A tap opens it. The
 * changes are one of these lines too, named "View the changes".
 */
function FileRow({
  name,
  onOpen,
  label,
  id,
}: {
  name: string;
  onOpen: () => void;
  label?: string;
  id?: string;
}) {
  const t = useTheme();
  const { t: say } = useT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? say('delivery.openFile', { name })}
      {...(id ? { testID: `button-${id}` } : {})}
      onPress={onOpen}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: TOUCH,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon name="file" color={t.inkMuted} />
      <T kind="muted" numberOfLines={1} style={{ flex: 1 }}>
        {name}
      </T>
    </Pressable>
  );
}

/**
 * A finished task as one result card: the outcome in one sentence, a small proof from the box beside
 * its caption, the files as quiet lines and at most two one-tap actions, each as wide as its words.
 * The visual opens large over the screen.
 */
const VIEW_SHAPE = {
  Desktop: { flex: 5, aspectRatio: 16 / 10, borderRadius: radius.small },
  Tablet: { flex: 2.4, aspectRatio: 3 / 4, borderRadius: 14 },
  Phone: { flex: 1.3, aspectRatio: 9 / 19.5, borderRadius: 16 },
} as const;

/** One screenshot at one viewport, framed like that device, labelled, opening large on a tap. */
function ViewShot({
  client,
  taskId,
  view,
  onOpen,
  onFailed,
}: {
  client: CloudClient;
  taskId: string;
  view: DeliveryView;
  onOpen: (blob: Blob) => void;
  onFailed: () => void;
}) {
  const t = useTheme();
  const { t: say, tx } = useT();
  const viewport = tx(view.viewport);
  const [blob, setBlob] = useState<Blob | undefined>();
  const { uri, failed } = usePicture(blob);
  const index = view.listing.index;
  useEffect(() => {
    let current = true;
    client
      .readArtifact(taskId, index)
      .then((content) => current && content.kind === 'image' && setBlob(content.blob))
      .catch(() => current && onFailed());
    return () => {
      current = false;
    };
  }, [client, taskId, index, onFailed]);
  useEffect(() => {
    if (failed) onFailed();
  }, [failed, onFailed]);
  const { flex, aspectRatio, borderRadius } = VIEW_SHAPE[view.viewport];
  return (
    <View style={{ flex, gap: 4, alignItems: 'center' }}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={say('delivery.openLarge', { name: viewport })}
        disabled={!blob}
        onPress={() => blob && onOpen(blob)}
        style={{ width: '100%' }}
      >
        <View
          style={{
            width: '100%',
            aspectRatio,
            borderRadius,
            borderWidth: 1,
            borderColor: t.cardEdge,
            backgroundColor: t.chip,
            overflow: 'hidden',
          }}
        >
          {uri ? (
            <Image
              source={{ uri }}
              accessibilityLabel={say('common.labelValue', {
                label: viewport,
                value: displayText(view.listing.name),
              })}
              resizeMode="cover"
              resizeMethod="resize"
              style={{ width: '100%', height: '100%' }}
            />
          ) : null}
        </View>
      </Pressable>
      <T kind="small">{viewport}</T>
    </View>
  );
}

export function DeliveryCard({
  client,
  task,
  model,
  files = [],
  onOpenTask,
  onFromTask,
}: {
  client: CloudClient;
  task: TaskView;
  model: DeliveryModel;
  /** The other files the task made, each shown as one quiet line. */
  files?: readonly ArtifactListing[];
  onOpenTask?: (task: TaskView) => void;
  /** Where the chat shows the task this result came from: a small "from task" link goes back to it. */
  onFromTask?: () => void;
}) {
  const t = useTheme();
  const { t: say, tx } = useT();
  // The outcome is the task's own words, and so is a single picture's caption; the viewport list
  // and "The changes" are the shared logic's.
  const { diff, outcome, actions, views } = model;
  const caption = views || !model.shot ? tx(model.caption) : model.caption;
  // With views each screenshot loads itself; the single picture is not loaded a second time.
  const shot = views ? undefined : model.shot;
  const [proof, setProof] = useState<Blob | undefined>();
  const { uri: proofUri, failed: proofFailed } = usePicture(proof);
  const [opened, setOpened] = useState<Opened | undefined>();
  const [failed, setFailed] = useState(false);
  const markFailed = useCallback(() => setFailed(true), []);
  const shotIndex = shot?.index;
  useEffect(() => {
    if (shotIndex === undefined) return;
    let current = true;
    client
      .readArtifact(task.taskId, shotIndex)
      .then((content) => current && content.kind === 'image' && setProof(content.blob))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [client, task.taskId, shotIndex]);

  async function openDiff() {
    if (!diff) return;
    try {
      const content = await client.readArtifact(task.taskId, diff.index);
      if (content.kind === 'text')
        setOpened({ kind: 'diff', title: caption || tx('The changes'), text: content.text });
    } catch {
      setFailed(true);
    }
  }

  const [fileFailed, setFileFailed] = useState(false);
  async function openFile(file: ArtifactListing) {
    setFileFailed(false);
    const title = displayText(file.name);
    try {
      const content = await client.readArtifact(task.taskId, file.index);
      if (content.kind === 'image') setOpened({ kind: 'image', title, blob: content.blob });
      else if (content.kind === 'text')
        setOpened({ kind: isDiffListing(file) ? 'diff' : 'text', title, text: content.text });
      else setFileFailed(true);
    } catch {
      setFileFailed(true);
    }
  }

  const taskTitle = task.title ? displayText(task.title) : say('task.title');
  return (
    <Card label={say('delivery.result', { title: taskTitle })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <StatusMark tone="ok" />
        <T kind="small" style={{ flex: 1 }}>
          {say('delivery.finished')}
        </T>
        {onOpenTask && (
          <Pressable
            accessibilityRole="button"
            testID="button-Details"
            accessibilityLabel={say('common.details')}
            onPress={() => onOpenTask(task)}
            style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 }}
          >
            <T kind="muted" style={{ textDecorationLine: 'underline' }}>
              {say('common.details')}
            </T>
          </Pressable>
        )}
      </View>
      <T kind="heading">{outcome}</T>
      {views ? (
        <View
          accessibilityLabel={caption}
          style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, maxWidth: 300 }}
        >
          {views.map((view) => (
            <ViewShot
              key={view.viewport}
              client={client}
              taskId={task.taskId}
              view={view}
              onOpen={(blob) => setOpened({ kind: 'image', title: tx(view.viewport), blob })}
              onFailed={markFailed}
            />
          ))}
        </View>
      ) : shot && proofUri ? (
        // A thumbnail beside its caption; a tap shows it large.
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Pressable
            testID="delivery-picture"
            accessibilityRole="imagebutton"
            accessibilityLabel={say('delivery.openLarge', {
              name: caption || say('delivery.picture'),
            })}
            onPress={() =>
              setOpened({ kind: 'image', title: caption || say('delivery.picture'), blob: proof })
            }
          >
            <Image
              source={{ uri: proofUri }}
              accessibilityLabel={displayText(shot.name)}
              resizeMode="cover"
              resizeMethod="resize"
              style={{
                width: 112,
                aspectRatio: 16 / 10,
                borderRadius: radius.small,
                borderWidth: 1,
                borderColor: t.cardEdge,
                backgroundColor: t.chip,
              }}
            />
          </Pressable>
          {caption ? (
            <T kind="muted" style={{ flex: 1 }}>
              {caption}
            </T>
          ) : null}
        </View>
      ) : null}
      {caption && !views && !(shot && proofUri) ? <T kind="muted">{caption}</T> : null}
      {model.noPicture ? (
        <T kind="muted">{say('delivery.noPicture', { reason: model.noPicture })}</T>
      ) : null}
      {(failed || proofFailed) && <T kind="muted">{say('delivery.pictureFailed')}</T>}
      {(files.length > 0 || (diff && !views && !shot)) && (
        <View>
          {diff && !views && !shot && (
            <FileRow
              name={say('delivery.viewChanges')}
              label={say('delivery.viewChanges')}
              id="View the changes"
              onOpen={() => void openDiff()}
            />
          )}
          {files.map((file) => (
            <FileRow
              key={file.index}
              name={displayText(file.name)}
              onOpen={() => void openFile(file)}
            />
          ))}
        </View>
      )}
      {fileFailed && <T kind="muted">{say('delivery.fileFailed')}</T>}
      {actions.length > 0 && (
        // The button says what it does; where it goes is for the screen reader and the arrow.
        <ButtonRow>
          {actions.slice(0, 2).map((action, i) => (
            <PillButton
              key={action.label}
              label={tx(action.label)}
              accessibilityLabel={say('delivery.action', {
                label: tx(action.label),
                host: action.host,
              })}
              id={`${action.label} · ${action.host}`}
              primary={i === 0}
              compact
              external
              onPress={() => openLink(action.url)}
            />
          ))}
        </ButtonRow>
      )}
      {onFromTask && (
        <Pressable
          testID="button-From task"
          accessibilityRole="link"
          accessibilityLabel={say('result.fromTaskLabel', { title: taskTitle })}
          onPress={onFromTask}
          hitSlop={4}
          style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <Icon name="conversations" color={t.inkMuted} />
          <T
            kind="small"
            style={{ flexShrink: 1, textDecorationLine: 'underline' }}
            numberOfLines={1}
          >
            {say('result.fromTask', { title: taskTitle })}
          </T>
        </Pressable>
      )}
      {opened && (
        <Viewer title={opened.title} onClose={() => setOpened(undefined)}>
          {opened.kind === 'image' && opened.blob && (
            <ViewerPicture blob={opened.blob} title={opened.title} />
          )}
          {opened.kind === 'diff' && <DiffLines text={opened.text ?? ''} />}
          {opened.kind === 'text' && <Report text={opened.text ?? ''} />}
        </Viewer>
      )}
    </Card>
  );
}

function SourceCard({
  client,
  taskId,
  source,
}: {
  client: CloudClient;
  taskId: string;
  source: SourceListing;
}) {
  const t = useTheme();
  const { t: say, tx } = useT();
  const [preview, setPreview] = useState<SourcePreview | undefined>();
  const [picture, setPicture] = useState<Blob | undefined>();
  const uri = useBlobUri(picture);
  useEffect(() => {
    let current = true;
    client
      .sourcePreview(taskId, source.index)
      .then(async (result) => {
        if (!current) return;
        setPreview(result);
        if (!result.image) return;
        const blob = await client.sourceImage(taskId, source.index);
        if (current) setPicture(blob);
      })
      .catch(() => {
        // A page that cannot be previewed is still a card, with the site's initial.
      });
    return () => {
      current = false;
    };
  }, [client, taskId, source.index]);
  const site = displayText(source.site);
  const title = displayText(preview?.title ?? source.site);
  const href = publicLink(source.url);
  const kind = tx(LABEL_WORDS[source.label]);
  return (
    <Pressable
      accessibilityRole={href ? 'link' : 'text'}
      accessibilityLabel={say('delivery.source', { title, site, label: kind })}
      disabled={!href}
      onPress={() => href && openLink(href)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 6,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: t.chip,
        }}
      >
        {uri ? (
          <Image source={{ uri }} style={{ width: 40, height: 40 }} />
        ) : (
          <T kind="heading">{site.charAt(0).toUpperCase()}</T>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <T kind="body" numberOfLines={1}>
          {title}
        </T>
        <T kind="small" numberOfLines={1}>
          {site} · {kind}
        </T>
      </View>
    </Pressable>
  );
}

/** Up to three of the pages the task opened, folded into one line until it is opened. */
export function SourcesStack({
  client,
  taskId,
  sources,
}: {
  client: CloudClient;
  taskId: string;
  sources: readonly SourceListing[];
}) {
  const t = useTheme();
  const { t: say } = useT();
  const [open, setOpen] = useState(false);
  const shown = stackOf(sources);
  if (shown.length === 0) return null;
  return (
    <Card label={say('delivery.sources')}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={say('delivery.sourcesCount', { count: shown.length })}
        testID="delivery-sources"
        onPress={() => setOpen(!open)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          minHeight: TOUCH,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <T kind="muted" style={{ flex: 1 }}>
          {say('delivery.sourcesCount', { count: shown.length })}
        </T>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} color={t.inkMuted} />
      </Pressable>
      {open &&
        shown.map((source) => (
          <SourceCard key={source.index} client={client} taskId={taskId} source={source} />
        ))}
    </Card>
  );
}

/** The pages a task opened; read again when `refresh` changes. */
export function useSources(client: CloudClient, taskId: string, refresh: string): SourceListing[] {
  const [sources, setSources] = useState<SourceListing[]>([]);
  useEffect(() => {
    let current = true;
    void loadSources(client, taskId).then((loaded) => current && setSources(loaded));
    return () => {
      current = false;
    };
  }, [client, taskId, refresh]);
  return sources;
}

/** One top-level task's place in the chat: its result card when it finished, and the pages it opened. */
export function TaskDelivery({
  client,
  task,
  listings,
  onOpenTask,
  onFromTask,
}: {
  client: CloudClient;
  task: TaskView;
  listings: readonly ArtifactListing[];
  onOpenTask?: (task: TaskView) => void;
  onFromTask?: () => void;
}) {
  const sources = useSources(client, task.taskId, task.state);
  const model = deliveryModel(task, listings, sources);
  // Every other file is one quiet line: not the pictures, and not the diff when the card already
  // offers it as "View the changes".
  const diffShown = model && !model.views && !model.shot ? model.diff : undefined;
  const files = listings.filter(
    (listing) => listing.kind === 'file' && !listing.image && listing.index !== diffShown?.index,
  );
  return (
    <>
      {model && (
        <DeliveryCard
          client={client}
          task={task}
          model={model}
          files={files}
          onOpenTask={onOpenTask}
          onFromTask={onFromTask}
        />
      )}
      <SourcesStack client={client} taskId={task.taskId} sources={sources} />
    </>
  );
}
