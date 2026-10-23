import {
  type CloudClient,
  confidenceWords,
  displayText,
  dollars,
  errorText,
  hostOf,
  type InboxItem,
  type LoadedResult,
  loadTaskResults,
  pullRequestOf,
  reviewLineOf,
  reviewWords,
  stepsOf,
  type TaskView,
  taskLabel,
  Unsupported,
  verdictOf,
} from '@maka-cloud/client';
import { useEffect, useState } from 'react';
import { Image, Modal, ScrollView, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useT } from '@/lib/i18n';
import { useBlobUri } from '@/lib/picture';
import { mono, radius, useTheme } from '@/lib/theme';
import { DiffLines, openLink, Report, SourcesStack, useSources } from './Delivery';
import { FailureNote, PillButton, Solid, StatusMark, T } from './ui';

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
  const { t: say, tx } = useT();
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
  // once, under Review, and left out of the plain list of what was done.
  const reviewLine = reviewLineOf(manifest?.done);
  const done = manifest?.done.filter((line) => line !== reviewLine) ?? [];
  const review = reviewWords(manifest?.done, verdict);
  const { steps } = stepsOf(task.progress);
  const pull = results ? pullRequestOf(results) : undefined;
  const title = task.title ? displayText(task.title) : say('task.title');
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      {/* A modal is its own native window: it needs its own insets, or the header sits under the status bar. */}
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: t.solid }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12 }}>
            <PillButton label={say('common.back')} id="Back" onPress={onClose} />
          </View>
          <ScrollView
            contentContainerStyle={{ padding: 16, gap: 16 }}
            accessibilityLabel={say('details.page', { title })}
          >
            <T kind="title">{title}</T>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <StatusMark tone={TONE[task.state as keyof typeof TONE] ?? 'attention'} />
              <T kind="muted" style={{ flex: 1 }}>
                {tx(taskLabel(task))}
                {task.costUsd !== undefined && ` · ${say('task.cost')} `}
                {task.costUsd !== undefined && (
                  <T kind="muted" style={mono}>
                    {task.budgetUsd !== undefined
                      ? say('task.ofBudget', {
                          spent: tx(dollars(task.costUsd)),
                          budget: tx(dollars(task.budgetUsd)),
                        })
                      : tx(dollars(task.costUsd))}
                  </T>
                )}
              </T>
            </View>
            {pull && (
              <PillButton
                label={say('details.pullRequest', { host: hostOf(pull) })}
                id={`Pull request · ${hostOf(pull)}`}
                primary
                external
                onPress={() => openLink(pull)}
              />
            )}
            {task.failureReason ? <FailureNote reason={task.failureReason} /> : null}
            {manifest && (
              <View style={{ gap: 8 }}>
                <T kind="heading" testID="details-outcome">
                  {say('details.outcome')}
                </T>
                <T kind="body" selectable>
                  {displayText(manifest.summary)}
                </T>
                <T kind="muted">{tx(confidenceWords(manifest.confidence))}</T>
                <List title={say('details.done')} items={done} />
                <List title={say('details.notDone')} items={manifest.notDone} />
                <List title={say('details.knownIssues')} items={manifest.knownIssues} />
              </View>
            )}
            {review.length > 0 && (
              <View style={{ gap: 4 }}>
                <T kind="heading">{say('details.review')}</T>
                {review.map((line) => (
                  <T key={line} kind="body">
                    {tx(line)}
                  </T>
                ))}
              </View>
            )}
            {steps.length > 0 && (
              <View style={{ gap: 4 }}>
                <T kind="heading">{say('details.steps')}</T>
                {steps.map((step, i) => (
                  <T key={i} kind="body">{`${i + 1}. ${displayText(step)}`}</T>
                ))}
              </View>
            )}
            <View style={{ gap: 10 }}>
              <T kind="heading">{say('details.results')}</T>
              {error ? <T kind="error">{tx(error)}</T> : null}
              {results === undefined && <T kind="muted">{say('details.loading')}</T>}
              {results?.length === 0 && !error && <T kind="muted">{say('details.none')}</T>}
              {results?.map((result, i) => (
                <View key={i} style={{ gap: 6 }}>
                  <T kind="small">{displayText(result.name)}</T>
                  {result.kind === 'diff' && <DiffLines text={result.text} />}
                  {result.kind === 'report' && <Report text={result.text} />}
                  {result.kind === 'image' && <ImageResult name={result.name} blob={result.blob} />}
                  {result.kind === 'link' && (
                    <PillButton label={result.url} external onPress={() => openLink(result.url)} />
                  )}
                  {result.kind === 'failed' && <T kind="muted">{say('details.resultFailed')}</T>}
                </View>
              ))}
            </View>
            <SourcesStack client={client} taskId={task.taskId} sources={sources} />
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}
