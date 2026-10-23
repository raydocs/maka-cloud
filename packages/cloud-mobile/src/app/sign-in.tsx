import { type AuthState, BRAND, errorText } from '@maka-cloud/client';
import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { Card, Field, PillButton, Screen, T } from '@/components/ui';
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
            {deep ? null : <T kind="title">Your next big thing, one conversation away.</T>}
            {deep ? null : <T kind="muted">A place to plan, follow the work, and bring it home.</T>}
          </View>
          {saved && (
            <Card label="Saved access">
              <T kind="muted">
                You are still signed in on this device.{' '}
                {session.status === 'out' ? session.error : ''}
              </T>
              <PillButton label="Try again" primary onPress={retry} />
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
              notice={session.status === 'out' && !saved ? session.error : ''}
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
  const go = () => {
    try {
      onChosen(normalizeServer(text));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That does not look like a server address.');
    }
  };
  return (
    <Card label="Server">
      <Field
        label="Server address"
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
      <PillButton primary label="Continue" disabled={!text.trim()} onPress={go} />
      {problem ? <T kind="error">{problem}</T> : null}
    </Card>
  );
}

/** The old way in, kept for invites made by hand (the beta, and the device tests). */
function TokenCard({ server, onBack }: { server: string; onBack: () => void }) {
  const { signIn } = useSession();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
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
    <Card label="Invite token">
      <Field
        label="Invite token"
        showLabel
        placeholder="Invite token"
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
        label={busy ? 'Connecting…' : 'Enter your workspace'}
        disabled={busy || !token.trim()}
        onPress={() => void submit()}
      />
      {problem ? <T kind="error">{problem}</T> : null}
      <TextLink label="Other ways to sign in" onPress={onBack} />
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
  return (
    <>
      <Card label="Sign in">
        <Step state={state} flow={flow} notice={notice} onToken={onToken} />
      </Card>
      <View style={{ alignItems: 'center' }}>
        <T kind="small">{host}</T>
        {onChangeServer ? <TextLink label="Use another server" onPress={onChangeServer} /> : null}
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
  if (state.step === 'loading' || state.step === 'signedIn')
    return <T kind="muted">{state.step === 'loading' ? 'Connecting…' : 'Signed in.'}</T>;
  if (state.step === 'failed')
    return (
      <>
        <T kind="error">{state.message}</T>
        <PillButton label="Try again" primary onPress={() => void flow.start()} />
        <TextLink label="I have an invite token" onPress={onToken} />
      </>
    );
  if (state.step === 'working') return <T kind="muted">One moment…</T>;
  if (state.step === 'emailSent')
    return (
      <>
        <T kind="heading">Check your email</T>
        <T kind="muted">
          We sent a 6-digit code to {state.address}. It works once, for ten minutes.
        </T>
        <Field
          label="Code"
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
        {state.error ? <T kind="error">{state.error}</T> : null}
        <PillButton
          primary
          label="Sign in"
          disabled={!code.trim()}
          onPress={() => void flow.verifyEmail(code)}
        />
        <PillButton label="Send a new code" onPress={() => void flow.sendEmail(state.address)} />
        <TextLink label="Use another way" onPress={() => flow.back()} />
      </>
    );
  if (state.step === 'needsInvite')
    return (
      <>
        <T kind="heading">Enter your invite code</T>
        <T kind="muted">Maka is by invitation for now. You only need to do this once.</T>
        <Field
          label="Invite code"
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
        {state.error ? <T kind="error">{state.error}</T> : null}
        <PillButton
          primary
          label="Continue"
          disabled={!invite.trim()}
          onPress={() => void flow.claim(invite)}
        />
        <TextLink label="Use another way" onPress={() => flow.back()} />
      </>
    );
  const apple = state.ways.apple && nativeProviders.apple;
  const google = state.ways.google && nativeProviders.google;
  return (
    <>
      <T kind="heading">Sign in</T>
      {apple ? (
        <PillButton
          primary
          label="Continue with Apple"
          onPress={() => void flow.signInWith('apple')}
        />
      ) : null}
      {google ? (
        <PillButton label="Continue with Google" onPress={() => void flow.signInWith('google')} />
      ) : null}
      {state.ways.email ? (
        <>
          <Field
            label="Email"
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
            label="Email me a code"
            disabled={!address.trim()}
            onPress={() => void flow.sendEmail(address)}
          />
        </>
      ) : null}
      {!apple && !google && !state.ways.email ? (
        <T kind="muted">This server has no sign-in set up yet. Use your invite token.</T>
      ) : null}
      {state.error || notice ? <T kind="error">{state.error || notice}</T> : null}
      <TextLink label="I have an invite token" onPress={onToken} />
    </>
  );
}

/** A quiet text button, at least 44 pt tall. */
function TextLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      testID={`button-${label}`}
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <T kind="muted" style={{ textDecorationLine: 'underline' }}>
        {label}
      </T>
    </Pressable>
  );
}
