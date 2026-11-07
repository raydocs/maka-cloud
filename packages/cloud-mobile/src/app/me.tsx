import {
  ApiError,
  BRAND,
  displayText,
  type Grant,
  type MemoryProfile,
  Unsupported,
} from '@maka-cloud/client';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Devices } from '@/components/Devices';
import { NotificationsCard } from '@/components/Notifications';
import { ButtonRow, Card, PillButton, QuietButton, Screen, T } from '@/components/ui';
import { type ModeChoice, useAppearance } from '@/lib/appearance';
import { type Language, useT } from '@/lib/i18n';
import { useSession, useWorkspace } from '@/lib/session';
import type { Key } from '@/lib/strings';

const CHOICES: ReadonlyArray<{ value: ModeChoice; label: Key; id: string }> = [
  { value: 'system', label: 'settings.system', id: 'System' },
  { value: 'light', label: 'settings.lightChoice', id: 'Light' },
  { value: 'dark', label: 'settings.darkChoice', id: 'Dark' },
];

/** Each language in its own words, so it can be found whatever the app is showing. */
const LANGUAGE_NAMES: ReadonlyArray<{ value: Language; name: string }> = [
  { value: 'zh-Hans', name: '简体中文' },
  { value: 'zh-Hant', name: '繁體中文' },
  { value: 'en', name: 'English' },
];

/**
 * The phone's language (the default), or one of three; a language picked is kept on this device
 * and wins over the phone's own until "use phone language" is picked again.
 */
function LanguagePicker() {
  const { t: say, chosen, choose } = useT();
  return (
    <Card label={say('settings.language')}>
      <T kind="heading">{say('settings.language')}</T>
      <T kind="muted">{say('settings.language.body')}</T>
      <ButtonRow>
        <PillButton
          label={say('settings.language.phone')}
          // Appearance has a "跟随系统" too: a screen reader hears which one this is.
          accessibilityLabel={say('common.labelValue', {
            label: say('settings.language'),
            value: say('settings.language.phone'),
          })}
          id="language-phone"
          compact
          primary={chosen === undefined}
          onPress={() => choose(undefined)}
        />
        {LANGUAGE_NAMES.map(({ value, name }) => (
          <PillButton
            key={value}
            label={name}
            id={`language-${value}`}
            compact
            primary={chosen === value}
            onPress={() => choose(value)}
          />
        ))}
      </ButtonRow>
    </Card>
  );
}

/** The server does not offer this at all (as opposed to failing to answer this time). */
const absent = (error: unknown) =>
  error instanceof Unsupported ||
  (error instanceof ApiError && (error.status === 404 || error.status === 405));

/**
 * Something the server may or may not keep. Where it keeps none, nothing shows; where loading
 * fails, what was loaded stays and the failure is said, with a retry.
 */
function useOptional<Data>(read: () => Promise<Data>) {
  const [data, setData] = useState<Data | undefined>();
  const [none, setNone] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(() => {
    let current = true;
    read().then(
      (loaded) => {
        if (!current) return;
        setData(loaded);
        setLoadFailed(false);
      },
      (error: unknown) => {
        if (!current) return;
        if (absent(error)) setNone(true);
        else setLoadFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [read]);
  useEffect(load, [load]);
  return { data, none, loadFailed, load };
}

/** Says a failed load, with a retry. */
function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const { t: say } = useT();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <T kind="error" style={{ flex: 1 }}>
        {say('me.loadFailed')}
      </T>
      <QuietButton label={say('common.tryAgain')} onPress={onRetry} />
    </View>
  );
}

/** What the agent remembers about the person; each fact can be forgotten. Hidden where the server keeps none. */
function Memory() {
  const { client } = useWorkspace();
  const { t: say } = useT();
  const read = useCallback(() => client.memory(), [client]);
  const { data: memory, none, loadFailed, load } = useOptional<MemoryProfile>(read);
  const [failed, setFailed] = useState(false);
  if (none || (!memory && !loadFailed)) return null;
  if (!memory)
    return (
      <Card label={say('me.memory')}>
        <T kind="heading">{say('me.memory')}</T>
        <LoadFailed onRetry={load} />
      </Card>
    );
  return (
    <Card label={say('me.memory')}>
      <T kind="heading">{say('me.memory')}</T>
      <T kind="muted">{say('me.memory.body', { name: BRAND.name })}</T>
      {memory.facts.length === 0 && <T kind="muted">{say('me.memory.none')}</T>}
      {memory.facts.map((fact) => (
        <View key={fact.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T kind="body" style={{ flex: 1 }}>
            {displayText(fact.text)}
          </T>
          <QuietButton
            label={say('me.memory.forget')}
            accessibilityLabel={say('me.memory.forgetLabel', { text: displayText(fact.text) })}
            onPress={() => {
              setFailed(false);
              client.deleteFact(fact.id).then(load, () => setFailed(true));
            }}
          />
        </View>
      ))}
      {failed && <T kind="error">{say('me.failed')}</T>}
      {loadFailed && <LoadFailed onRetry={load} />}
    </Card>
  );
}

/** The approvals kept beyond one time, each revocable in one tap. Hidden where nothing keeps them. */
function KeptApprovals() {
  const { client } = useWorkspace();
  const { t: say } = useT();
  const read = useCallback(() => client.listGrants(), [client]);
  const { data: grants, none, loadFailed, load } = useOptional<Grant[]>(read);
  const [failed, setFailed] = useState(false);
  if (none || (!grants && !loadFailed)) return null;
  if (!grants)
    return (
      <Card label={say('me.grants')}>
        <T kind="heading">{say('me.grants')}</T>
        <LoadFailed onRetry={load} />
      </Card>
    );
  return (
    <Card label={say('me.grants')}>
      <T kind="heading">{say('me.grants')}</T>
      <T kind="muted">{say('me.grants.body', { name: BRAND.name })}</T>
      {grants.length === 0 && <T kind="muted">{say('me.grants.none')}</T>}
      {grants.map((grant) => (
        <View key={grant.grantId} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <T kind="body">{`${displayText(grant.tool)} · ${displayText(grant.repository)}`}</T>
            <T kind="small">
              {say(grant.scope === 'task' ? 'me.grants.task' : 'me.grants.repository')}
            </T>
          </View>
          <QuietButton
            label={say('me.grants.revoke')}
            accessibilityLabel={say('me.grants.revokeLabel', {
              tool: displayText(grant.tool),
              repository: displayText(grant.repository),
            })}
            onPress={() => {
              setFailed(false);
              client.revokeGrant(grant.grantId).then(load, () => setFailed(true));
            }}
          />
        </View>
      ))}
      {failed && <T kind="error">{say('me.failed')}</T>}
      {loadFailed && <LoadFailed onRetry={load} />}
    </Card>
  );
}

/**
 * Me, opened from the round button at the top right: appearance, language, what the agent
 * remembers, the approvals it keeps, this account's devices, and signing out.
 */
export default function Me() {
  const { signOut } = useSession();
  const { client } = useWorkspace();
  const router = useRouter();
  const { mode, choice, setMode } = useAppearance();
  const [signOutError, setSignOutError] = useState('');
  const { t: say } = useT();
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <T kind="title" style={{ flex: 1 }}>
            {say('me.title')}
          </T>
          <PillButton
            label={say('common.close')}
            id="Close Me"
            compact
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          />
        </View>
        <Card label={say('settings.appearance')}>
          <T kind="heading">{say('settings.appearance')}</T>
          <T kind="muted">
            {choice === 'system'
              ? say('settings.follows', {
                  mode: say(mode === 'dark' ? 'settings.dark' : 'settings.light'),
                })
              : say(mode === 'dark' ? 'settings.darkOn' : 'settings.lightOn')}
          </T>
          <ButtonRow>
            {CHOICES.map(({ value, label, id }) => (
              <PillButton
                key={value}
                label={say(label)}
                id={id}
                compact
                primary={choice === value}
                onPress={() => setMode(value)}
              />
            ))}
          </ButtonRow>
        </Card>
        <LanguagePicker />
        <NotificationsCard place="me" />
        <Memory />
        <KeptApprovals />
        <Devices client={client} />
        <Card label={say('settings.account')}>
          <T kind="heading">{say('settings.account')}</T>
          <T kind="muted">{say('settings.account.body')}</T>
          {signOutError ? <T kind="error">{signOutError}</T> : null}
          <PillButton
            label={say('settings.signOut')}
            id="Sign out"
            compact
            haptic="warning"
            onPress={() => {
              setSignOutError('');
              signOut().catch(() => setSignOutError(say('settings.signOutFailed')));
            }}
          />
        </Card>
      </ScrollView>
    </Screen>
  );
}
