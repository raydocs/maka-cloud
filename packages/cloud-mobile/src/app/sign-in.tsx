import { type AuthState, BRAND, type ErrorText, errorText } from '@maka-cloud/client';
import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { Card, Field, PillButton, Screen, T } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { authPlatform, nativeProviders } from '@/lib/providers';
import { useAuthFlow } from '@/lib/useAuthFlow';
import { normalizeServer } from '@/lib/server';
import { useSession } from '@/lib/session';

/** The owner's server, set when the app is built. Without it the person types the address. */
const BUILT_IN_SERVER = (Constants.expoConfig?.extra as { server?: string } | undefined)?.server;

export default function SignIn() {
  const { session, retry } = useSession();
  const remembered = session.status === 'out' ? session.server : '';
  const [server, setServer] = useState(BUILT_IN_SERVER || remembered);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState(false);
  /** A code or invite step is on screen: the header gives way, so the keyboard leaves room for the button. */
  const [deep, setDeep] = useState(false);
  const saved = session.status === 'out' && session.saved;
  const { t: say, tx } = useT();
  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          // Top-aligned, so the form does not slide when the keyboard opens.
          contentContainerStyle={{ padding: 20, paddingTop: 56, gap: 20 }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ gap: 8 }}>
            <T kind="small">{BRAND.wordmark}</T>
            {deep ? null : <T kind="title">{say('signin.headline')}</T>}
            {deep ? null : <T kind="muted">{say('signin.tagline')}</T>}
          </View>
          {saved && (
            <Card label={say('signin.saved.label')}>
              <T kind="muted">
                {say('signin.saved')} {session.status === 'out' ? tx(session.error) : ''}
              </T>
              <PillButton label={say('common.tryAgain')} id="Try again" primary onPress={retry} />
            </Card>
          )}
          {!server || editing ? (
            <ServerCard
              initial={server}
              onChosen={(chosen) => {
                setServer(chosen);
                setEditing(false);
              }}
            />
          ) : token ? (
            <TokenCard server={server} onBack={() => setToken(false)} />
          ) : (
            <Ways
              server={server}
              onToken={() => setToken(true)}
              onDeep={setDeep}
              onChangeServer={BUILT_IN_SERVER ? undefined : () => setEditing(true)}
              notice={session.status === 'out' && !saved ? tx(session.error) : ''}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function ServerCard({
  initial,
  onChosen,
}: {
  initial: string;
  onChosen: (server: string) => void;
}) {
  const [text, setText] = useState(initial);
  const [problem, setProblem] = useState('');
  const { t: say, tx } = useT();
  const go = () => {
    try {
      onChosen(normalizeServer(text));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That does not look like a server address.');
    }
  };
  return (
    <Card label={say('signin.server.label')}>
      <Field
        label={say('signin.server')}
        id="Server address"
        showLabel
        placeholder="maka.example.com"
        value={text}
        onChangeText={(value) => {
          setText(value);
          setProblem('');
        }}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        textContentType="URL"
        returnKeyType="go"
        onSubmitEditing={go}
      />
      <PillButton
        primary
        label={say('signin.continue')}
        id="Continue"
        disabled={!text.trim()}
        onPress={go}
      />
      {problem ? <T kind="error">{tx(problem)}</T> : null}
    </Card>
  );
}

/** The old way in, kept for invites made by hand (the beta, and the device tests). */
function TokenCard({ server, onBack }: { server: string; onBack: () => void }) {
  const { signIn } = useSession();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ErrorText>('');
  const { t: say, tx } = useT();
  async function submit() {
    if (busy) return;
    setBusy(true);
    setProblem('');
    try {
      await signIn(server, token);
    } catch (e) {
      setProblem(e instanceof Error && !('status' in e) ? e.message : errorText(e));
      setBusy(false);
    }
  }
  return (
    <Card label={say('signin.token')}>
      <Field
        label={say('signin.token')}
        id="Invite token"
        showLabel
        placeholder={say('signin.token')}
        value={token}
        onChangeText={setToken}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
      <PillButton
        primary
        label={say(busy ? 'signin.connecting' : 'signin.enter')}
        id={busy ? 'Connecting…' : 'Enter your workspace'}
        disabled={busy || !token.trim()}
        onPress={() => void submit()}
      />
      {problem ? <T kind="error">{tx(problem)}</T> : null}
      <TextLink label={say('signin.otherWays')} id="Other ways to sign in" onPress={onBack} />
    </Card>
  );
}

function Ways({
  server,
  onToken,
  onDeep,
  onChangeServer,
  notice,
}: {
  server: string;
  onToken: () => void;
  onDeep: (deep: boolean) => void;
  onChangeServer: (() => void) | undefined;
  notice: string;
}) {
  const { signIn } = useSession();
  const { flow, state } = useAuthFlow(server, authPlatform, (token) => signIn(server, token));
  const deep = state.step === 'emailSent' || state.step === 'needsInvite';
  useEffect(() => {
    onDeep(deep);
    return () => onDeep(false);
  }, [deep, onDeep]);
  const host = server.replace(/^https?:\/\//u, '');
  const { t: say } = useT();
  // The server's address is plumbing: it waits behind "Advanced" with the way to change it.
  const [advanced, setAdvanced] = useState(false);
  return (
    <>
      <Card label={say('signin.label')}>
        <Step state={state} flow={flow} notice={notice} onToken={onToken} />
      </Card>
      <View style={{ alignItems: 'center' }}>
        <TextLink
          label={say('signin.advanced')}
          id="Advanced"
          expanded={advanced}
          onPress={() => setAdvanced(!advanced)}
        />
        {advanced && (
          <>
            <T kind="small">{host}</T>
            {onChangeServer ? (
              <TextLink
                label={say('signin.anotherServer')}
                id="Use another server"
                onPress={onChangeServer}
              />
            ) : null}
          </>
        )}
      </View>
    </>
  );
}

function Step({
  state,
  flow,
  notice,
  onToken,
}: {
  state: AuthState;
  flow: ReturnType<typeof useAuthFlow>['flow'];
  notice: string;
  onToken: () => void;
}) {
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState('');
  const { t: say, tx } = useT();
  if (state.step === 'loading' || state.step === 'signedIn')
    return (
      <T kind="muted">{say(state.step === 'loading' ? 'signin.connecting' : 'signin.signedIn')}</T>
    );
  if (state.step === 'failed')
    return (
      <>
        <T kind="error">{tx(state.message)}</T>
        <PillButton
          label={say('common.tryAgain')}
          id="Try again"
          primary
          onPress={() => void flow.start()}
        />
        <TextLink label={say('signin.haveToken')} id="I have an invite token" onPress={onToken} />
      </>
    );
  if (state.step === 'working') return <T kind="muted">{say('signin.oneMoment')}</T>;
  if (state.step === 'emailSent')
    return (
      <>
        <T kind="heading" testID="signin-check-email">
          {say('signin.checkEmail')}
        </T>
        <T kind="muted">{say('signin.codeSent', { address: state.address })}</T>
        <Field
          label={say('signin.code')}
          id="Code"
          showLabel
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={12}
          returnKeyType="go"
          onSubmitEditing={() => void flow.verifyEmail(code)}
        />
        {state.error ? <T kind="error">{tx(state.error)}</T> : null}
        <PillButton
          primary
          label={say('signin.signIn')}
          id="Sign in"
          disabled={!code.trim()}
          onPress={() => void flow.verifyEmail(code)}
        />
        <PillButton
          label={say('signin.newCode')}
          id="Send a new code"
          onPress={() => void flow.sendEmail(state.address)}
        />
        <TextLink
          label={say('signin.anotherWay')}
          id="Use another way"
          onPress={() => flow.back()}
        />
      </>
    );
  if (state.step === 'needsInvite')
    return (
      <>
        <T kind="heading" testID="signin-invite-title">
          {say('signin.invite.title')}
        </T>
        <T kind="muted">{say('signin.invite.body', { name: BRAND.name })}</T>
        <Field
          label={say('signin.invite')}
          id="Invite code"
          showLabel
          value={invite}
          onChangeText={setInvite}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={() => void flow.claim(invite)}
        />
        {state.error ? <T kind="error">{tx(state.error)}</T> : null}
        <PillButton
          primary
          label={say('signin.continue')}
          id="Continue"
          disabled={!invite.trim()}
          onPress={() => void flow.claim(invite)}
        />
        <TextLink
          label={say('signin.anotherWay')}
          id="Use another way"
          onPress={() => flow.back()}
        />
      </>
    );
  const native = nativeProviders();
  const apple = state.ways.apple && native.apple;
  const google = state.ways.google && native.google;
  return (
    <>
      <T kind="heading">{say('signin.label')}</T>
      {apple ? (
        <PillButton
          primary
          label={say('signin.apple')}
          id="Continue with Apple"
          onPress={() => void flow.signInWith('apple')}
        />
      ) : null}
      {google ? (
        <PillButton
          label={say('signin.google')}
          id="Continue with Google"
          onPress={() => void flow.signInWith('google')}
        />
      ) : null}
      {state.ways.email ? (
        <>
          <Field
            label={say('signin.email')}
            id="Email"
            showLabel
            placeholder="you@example.com"
            value={address}
            onChangeText={setAddress}
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={() => void flow.sendEmail(address)}
          />
          <PillButton
            primary={!apple && !google}
            label={say('signin.emailMe')}
            id="Email me a code"
            disabled={!address.trim()}
            onPress={() => void flow.sendEmail(address)}
          />
        </>
      ) : null}
      {!apple && !google && !state.ways.email ? <T kind="muted">{say('signin.noWays')}</T> : null}
      {state.error || notice ? <T kind="error">{state.error ? tx(state.error) : notice}</T> : null}
      <TextLink label={say('signin.haveToken')} id="I have an invite token" onPress={onToken} />
    </>
  );
}

/**
 * A quiet text link in the small size, well below the main button's weight; at least 44 pt tall.
 * `id` names it for the device tests in any language; `expanded` makes it a disclosure.
 */
function TextLink({
  label,
  id,
  onPress,
  expanded,
}: {
  label: string;
  id: string;
  onPress: () => void;
  expanded?: boolean;
}) {
  return (
    <Pressable
      testID={`button-${id}`}
      accessibilityRole={expanded === undefined ? 'link' : 'button'}
      accessibilityLabel={label}
      {...(expanded === undefined ? {} : { accessibilityState: { expanded } })}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <T kind="small">{label}</T>
    </Pressable>
  );
}
