import { errorText } from '@maka-cloud/client';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { Card, Field, PillButton, Screen, T } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function SignIn() {
  const { session, signIn, retry } = useSession();
  const remembered = session.status === 'out' ? session.server : '';
  const [server, setServer] = useState(remembered);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const shown = problem || (session.status === 'out' && !session.saved ? session.error : '');
  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{ padding: 20, gap: 16, flexGrow: 1, justifyContent: 'center' }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ gap: 8 }}>
            <T kind="small">maka</T>
            <T kind="title">Your next big thing, one conversation away.</T>
            <T kind="muted">A place to plan, follow the work, and bring it home.</T>
          </View>
          {session.status === 'out' && session.saved && (
            <Card label="Saved access">
              <T kind="muted">You are still signed in on this device. {session.error}</T>
              <PillButton label="Try again" primary onPress={retry} />
            </Card>
          )}
          <Card label="Sign in">
            <Field
              label="Server address"
              showLabel
              placeholder="maka.example.com"
              value={server}
              onChangeText={setServer}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              textContentType="URL"
              returnKeyType="next"
            />
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
              disabled={busy || !server.trim() || !token.trim()}
              onPress={() => void submit()}
            />
            {shown ? <T kind="error">{shown}</T> : null}
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );

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
}
