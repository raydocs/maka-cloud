import {
  type CloudClient,
  displayText,
  dollars,
  errorText,
  type InboxItem,
  type LoadedResult,
  loadTaskResults,
  pullRequestOf,
  stepsOf,
  type TaskView,
  taskLabel,
  Unsupported,
  verdictOf,
} from '@maka-cloud/client';
import { useEffect, useState } from 'react';
import { Image, Modal, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useBlobUri } from '@/lib/picture';
import { radius, useTheme } from '@/lib/theme';
import { DiffLines, openLink, SourcesStack, useSources } from './Delivery';
import { PillButton, Solid, StatusMark, T } from './ui';

function List({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <View style={{ gap: 4 }}>
      <T kind="heading">{title}</T>
      {items.map((item, i) => (
        // The list never reorders, so the position is its identity.
        <T key={i} kind="body">{`• ${displayText(item)}`}</T>
      ))}
    </View>
  );
}

function ImageResult({ name, blob }: { name: string; blob: Blob }) {
  const uri = useBlobUri(blob);
  return uri ? (
    <Image
      source={{ uri }}
      accessibilityLabel={displayText(name)}
      resizeMode="contain"
      resizeMethod="resize"
      style={{ width: '100%', aspectRatio: 16 / 10, borderRadius: radius.small }}
    />
  ) : null;
}

const REPORT_CHARS = 20_000;

/** A report left by the task, as inert text on an opaque page; a very long one is cut short. */
function Report({ text }: { text: string }) {
  const t = useTheme();
  const [all, setAll] = useState(false);
  const shown = all ? text : text.slice(0, REPORT_CHARS);
  return (
    <Solid>
      <T kind="body" selectable style={{ color: t.solidInk }}>
        {displayText(shown)}
      </T>
      {shown.length < text.length && <PillButton label="Show all" onPress={() => setAll(true)} />}
    </Solid>
  );
}

const TONE = { succeeded: 'ok', failed: 'bad', cancelled: 'idle', paused: 'attention' } as const;

/**
 * One task in full, on a dense opaque page: what it did and did not do, how sure it is, the review,
 * the steps, the changes, the reports and pictures it left, the pages it opened and what it cost.
 * Results are read once when the page opens.
 */
export function TaskDetails({
  client,
  task,
  onClose,
}: {
  client: CloudClient;
  task: TaskView;
  onClose: () => void;
}) {
  const t = useTheme();
  const [results, setResults] = useState<LoadedResult[] | undefined>();
  const [verdict, setVerdict] = useState<InboxItem | undefined>();
  const [error, setError] = useState('');
  const sources = useSources(client, task.taskId, task.state);

  useEffect(() => {
    let current = true;
    loadTaskResults(client, task.taskId).then(
      (loaded) => current && setResults(loaded),
      (e: unknown) => {
        if (!current) return;
        setError(errorText(e));
        setResults([]);
      },
    );
    client
      .listInbox('all')
      .then((items) => current && setVerdict(verdictOf(items, task.taskId)))
      .catch((e: unknown) => {
        // A server with no inbox simply has no review to show.
        if (current && !(e instanceof Unsupported)) setVerdict(undefined);
      });
    return () => {
      current = false;
    };
  }, [client, task.taskId]);

  const manifest = task.manifest;
  // The runner's own `review:` line says whether a second agent reviewed the change; it is shown
  // on its own, in the runner's words, and left out of the plain list of what was done.
  const reviewLine = manifest?.done.find((line) => line.startsWith('review: '));
  const done = manifest?.done.filter((line) => line !== reviewLine) ?? [];
  const { steps } = stepsOf(task.progress);
  const pull = results ? pullRequestOf(results) : undefined;
  const title = displayText(task.title ?? 'Task');
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.solid }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12 }}>
          <PillButton label="Back" onPress={onClose} />
        </View>
        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 16 }}
          accessibilityLabel={`Task: ${title}`}
        >
          <T kind="title">{title}</T>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <StatusMark tone={TONE[task.state as keyof typeof TONE] ?? 'attention'} />
            <T kind="muted" style={{ flex: 1 }}>
              {taskLabel(task)} · Cost {dollars(task.costUsd)}
              {task.budgetUsd !== undefined && ` of ${dollars(task.budgetUsd)}`}
            </T>
          </View>
          {pull && <PillButton label="Pull request ↗" primary onPress={() => openLink(pull)} />}
          {task.failureReason ? <T kind="error">{displayText(task.failureReason)}</T> : null}
          {manifest && (
            <View style={{ gap: 8 }}>
              <T kind="heading">Outcome</T>
              <T kind="body" selectable>
                {displayText(manifest.summary)}
              </T>
              <T kind="muted">Confidence the agent reported: {manifest.confidence}</T>
              <List title="Done" items={done} />
              <List title="Not done" items={manifest.notDone} />
              <List title="Known issues" items={manifest.knownIssues} />
            </View>
          )}
          {reviewLine !== undefined && (
            <View style={{ gap: 4 }}>
              <T kind="heading">Independent review</T>
              <T kind="body">{displayText(reviewLine.slice('review: '.length))}</T>
            </View>
          )}
          {verdict && (
            <View style={{ gap: 4 }}>
              <T kind="heading">Review</T>
              <T kind="body">{displayText(verdict.ask)}</T>
            </View>
          )}
          {steps.length > 0 && (
            <View style={{ gap: 4 }}>
              <T kind="heading">Steps</T>
              {steps.map((step, i) => (
                <T key={i} kind="body">{`${i + 1}. ${displayText(step)}`}</T>
              ))}
            </View>
          )}
          <View style={{ gap: 10 }}>
            <T kind="heading">Results</T>
            {error ? <T kind="error">{error}</T> : null}
            {results === undefined && <T kind="muted">Loading the results…</T>}
            {results?.length === 0 && !error && <T kind="muted">This task left no results.</T>}
            {results?.map((result, i) => (
              <View key={i} style={{ gap: 6 }}>
                <T kind="small">{displayText(result.name)}</T>
                {result.kind === 'diff' && <DiffLines text={result.text} />}
                {result.kind === 'report' && <Report text={result.text} />}
                {result.kind === 'image' && <ImageResult name={result.name} blob={result.blob} />}
                {result.kind === 'link' && (
                  <PillButton label={`${result.url} ↗`} onPress={() => openLink(result.url)} />
                )}
                {result.kind === 'failed' && <T kind="muted">This result could not be loaded.</T>}
              </View>
            ))}
          </View>
          <SourcesStack client={client} taskId={task.taskId} sources={sources} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
