import { render, screen } from '@testing-library/react-native';
import { TextInput } from 'react-native';
import { Card } from '@/components/ui';

// iOS folds everything inside an `accessible` view into that one element: the sign-in fields vanished
// from VoiceOver and from the iOS simulator run's view hierarchy.
test('a card never groups what is inside it into one accessibility element', async () => {
  await render(
    <Card label="Sign in">
      <TextInput accessibilityLabel="Server address" />
    </Card>,
  );
  expect(screen.getByLabelText('Sign in').props.accessible).not.toBe(true);
  expect(screen.getByLabelText('Server address')).toBeTruthy();
});
