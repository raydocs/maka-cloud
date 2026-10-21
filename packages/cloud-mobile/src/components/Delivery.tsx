import {
  type ArtifactListing,
  type CloudClient,
  type DeliveryModel,
  deliveryModel,
  displayText,
  LABEL_WORDS,
  loadSources,
  publicLink,
  type SourceListing,
  type SourcePreview,
  stackOf,
  type TaskView,
} from '@maka-cloud/client';
import { useEffect, useState } from 'react';
import { Image, Linking, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useBlobUri, usePicture } from '@/lib/picture';
import { mono, radius, useTheme } from '@/lib/theme';
import { Card, PillButton, Solid, StatusMark, T } from './ui';

const MONO = Platform.OS === 'ios' ? mono.fontFamily : 'monospace';

const DIFF_LINES_SHOWN = 400;
/** The most lines ever drawn; a diff beyond this is read on the web. */
const DIFF_LINES_MAX = 5000;

/** A diff, line by line, on an opaque page: added lines green, removed lines red. A very long one is cut short. */
export function DiffLines({ text }: { text: string }) {
  const t = useTheme();
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
          label={`Show ${Math.min(lines.length, DIFF_LINES_MAX)} of ${lines.length} lines`}
          onPress={() => setAll(true)}
        />
      )}
      {all && lines.length > DIFF_LINES_MAX && (
        <T kind="small">{`Showing the first ${DIFF_LINES_MAX} of ${lines.length} lines. Read the rest on the web.`}</T>
      )}
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
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.solid }}>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12 }}
          accessibilityLabel={`Viewer: ${title}`}
        >
          <T kind="heading" style={{ flex: 1 }} numberOfLines={1}>
            {title}
          </T>
          <PillButton label="Close" onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={{ padding: 12 }}>{children}</ScrollView>
      </SafeAreaView>
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
  kind: 'image' | 'diff';
  title: string;
  blob?: Blob;
  text?: string;
}

/**
 * A finished task as one result card: the outcome in one sentence, one visual proof from the box, a
 * caption and at most two one-tap actions. The visual opens large over the screen.
 */
export function DeliveryCard({
  client,
  task,
  model,
  onOpenTask,
}: {
  client: CloudClient;
  task: TaskView;
  model: DeliveryModel;
  onOpenTask?: (task: TaskView) => void;
}) {
  const t = useTheme();
  const { shot, diff, outcome, caption, actions } = model;
  const [proof, setProof] = useState<Blob | undefined>();
  const { uri: proofUri, failed: proofFailed } = usePicture(proof);
  const [opened, setOpened] = useState<Opened | undefined>();
  const [failed, setFailed] = useState(false);
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
        setOpened({ kind: 'diff', title: caption || 'The changes', text: content.text });
    } catch {
      setFailed(true);
    }
  }

  return (
    <Card label={`Result: ${displayText(task.title ?? 'Task')}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <StatusMark tone="ok" />
        <T kind="small" style={{ flex: 1 }}>
          Finished
        </T>
        {onOpenTask && (
          <Pressable
            accessibilityRole="button"
            testID="button-Details"
            accessibilityLabel="Details"
            onPress={() => onOpenTask(task)}
            style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 }}
          >
            <T kind="muted" style={{ textDecorationLine: 'underline' }}>
              Details
            </T>
          </Pressable>
        )}
      </View>
      <T kind="heading">{outcome}</T>
      {shot && proofUri ? (
        <Pressable
          testID="delivery-picture"
          accessibilityRole="imagebutton"
          accessibilityLabel={`Open large: ${caption || 'picture'}`}
          onPress={() => setOpened({ kind: 'image', title: caption || 'Picture', blob: proof })}
        >
          <Image
            source={{ uri: proofUri }}
            accessibilityLabel={displayText(shot.name)}
            resizeMode="cover"
            resizeMethod="resize"
            style={{
              width: '100%',
              aspectRatio: 16 / 10,
              borderRadius: radius.small,
              backgroundColor: t.chip,
            }}
          />
        </Pressable>
      ) : (
        diff && <PillButton label="View the changes" onPress={() => void openDiff()} />
      )}
      {caption ? <T kind="muted">{caption}</T> : null}
      {(failed || proofFailed) && (
        <T kind="muted">The picture is too large or could not be loaded.</T>
      )}
      {actions.map((action, i) => (
        <PillButton
          key={action.label}
          label={`${action.label} · ${action.host} ↗`}
          primary={i === 0}
          onPress={() => openLink(action.url)}
        />
      ))}
      {opened && (
        <Viewer title={opened.title} onClose={() => setOpened(undefined)}>
          {opened.kind === 'image' && opened.blob && (
            <ViewerPicture blob={opened.blob} title={opened.title} />
          )}
          {opened.kind === 'diff' && <DiffLines text={opened.text ?? ''} />}
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
  return (
    <Pressable
      accessibilityRole={href ? 'link' : 'text'}
      accessibilityLabel={`${title}, ${site}, ${LABEL_WORDS[source.label]}`}
      disabled={!href}
      onPress={() => href && openLink(href)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        padding: 8,
        borderRadius: radius.small,
        backgroundColor: t.chip,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 8,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: t.card,
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
          {site} · {LABEL_WORDS[source.label]}
        </T>
      </View>
    </Pressable>
  );
}

/** Up to three of the pages the task opened. */
export function SourcesStack({
  client,
  taskId,
  sources,
}: {
  client: CloudClient;
  taskId: string;
  sources: readonly SourceListing[];
}) {
  const shown = stackOf(sources);
  if (shown.length === 0) return null;
  return (
    <Card label="Sources">
      <T kind="small">Sources</T>
      {shown.map((source) => (
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
}: {
  client: CloudClient;
  task: TaskView;
  listings: readonly ArtifactListing[];
  onOpenTask?: (task: TaskView) => void;
}) {
  const sources = useSources(client, task.taskId, task.state);
  const model = deliveryModel(task, listings, sources);
  return (
    <>
      {model && <DeliveryCard client={client} task={task} model={model} onOpenTask={onOpenTask} />}
      <SourcesStack client={client} taskId={task.taskId} sources={sources} />
    </>
  );
}
