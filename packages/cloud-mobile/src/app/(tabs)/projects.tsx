import {
  BRAND,
  type Conversation,
  ConversationStarter,
  displayText,
  errorText,
  type ProjectView,
  Unsupported,
} from '@maka-cloud/client';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Composer, Dock, TopFade, useConversationSheet } from '@/components/Composer';
import { Card, Screen, SkeletonLine, StatusMark, T, TOP_BAR } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useWorkspace } from '@/lib/session';

type Loaded =
  | { kind: 'loading' }
  | { kind: 'projects'; projects: ProjectView[] }
  | { kind: 'unsupported' }
  | { kind: 'failed'; message: string };

/**
 * Projects: the repositories the agent works in (the web's Projects page, from the same
 * `listProjects`), each with its standing duties. Read here; changed on the web.
 */
export default function Projects() {
  const { client, conversations, started } = useWorkspace();
  const router = useRouter();
  const { t: say, tx } = useT();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  useEffect(() => {
    let current = true;
    client.listProjects().then(
      (projects) => current && setLoaded({ kind: 'projects', projects }),
      (error: unknown) =>
        current &&
        setLoaded(
          error instanceof Unsupported
            ? { kind: 'unsupported' }
            : { kind: 'failed', message: errorText(error) },
        ),
    );
    return () => {
      current = false;
    };
  }, [client]);

  // The composer here starts a new conversation and shows it in Chat.
  const starter = useMemo(() => new ConversationStarter(client), [client]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState('');
  const [dock, setDock] = useState(76);
  const { openSheet, sheet } = useConversationSheet(() => router.navigate('/chat'));
  const send = () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    setFailure('');
    starter.start(draft).then(
      (conversation: Conversation) => {
        started(conversation);
        setDraft('');
        setSending(false);
        router.navigate('/chat');
      },
      (error: unknown) => {
        setFailure(errorText(error));
        setSending(false);
      },
    );
  };

  return (
    <Screen>
      <View style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{
            padding: 16,
            paddingTop: TOP_BAR + 12,
            paddingBottom: dock + 16,
            gap: 14,
          }}
          scrollIndicatorInsets={{ top: TOP_BAR, bottom: dock }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ gap: 6, paddingHorizontal: 4 }}>
            <T kind="title">{say('projects.title')}</T>
            <T kind="muted">{say('projects.body', { name: BRAND.name })}</T>
          </View>
          {loaded.kind === 'loading' && (
            <Card label={say('common.loading')}>
              <SkeletonLine width="60%" />
              <SkeletonLine width="40%" />
            </Card>
          )}
          {loaded.kind === 'unsupported' && (
            <T kind="muted" style={{ paddingHorizontal: 4 }}>
              {say('projects.unsupported')}
            </T>
          )}
          {loaded.kind === 'failed' && <T kind="error">{tx(loaded.message)}</T>}
          {loaded.kind === 'projects' && loaded.projects.length === 0 && (
            <T kind="muted">{say('projects.none', { name: BRAND.name })}</T>
          )}
          {loaded.kind === 'projects' &&
            loaded.projects.map((project) => (
              <Card key={project.projectId} label={displayText(project.repo)}>
                <T kind="heading">{displayText(project.repo)}</T>
                <T kind="small" style={{ fontVariant: ['tabular-nums'] }}>
                  {say('projects.branch', { branch: displayText(project.defaultBranch) })}
                  {project.duties.length > 0
                    ? ` · ${say('projects.duties', { count: project.duties.length })}`
                    : ''}
                </T>
                {project.duties.map((duty) => (
                  <View
                    key={duty.dutyId}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 32 }}
                  >
                    <StatusMark
                      tone={
                        duty.state === 'proposed'
                          ? 'attention'
                          : duty.state === 'active'
                            ? 'ok'
                            : 'idle'
                      }
                    />
                    <T kind="body" style={{ flex: 1 }}>
                      {displayText(duty.name)}
                    </T>
                    <T kind="small">
                      {say(
                        duty.state === 'proposed'
                          ? 'projects.dutyProposed'
                          : duty.state === 'active'
                            ? 'projects.dutyOn'
                            : 'projects.dutyOff',
                      )}
                    </T>
                  </View>
                ))}
              </Card>
            ))}
          {failure ? <T kind="error">{tx(failure)}</T> : null}
        </ScrollView>
        <TopFade />
        <Dock height={dock} onHeight={setDock}>
          <Composer
            draft={draft}
            onDraft={(text) => {
              setDraft(text);
              starter.draftEdited();
            }}
            sending={sending}
            disabled={sending}
            onSend={send}
            {...(conversations.length > 0 ? { onPlus: openSheet } : {})}
          />
        </Dock>
        {sheet}
      </View>
    </Screen>
  );
}
