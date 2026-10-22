import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { submitOnEnter } from '../src/keys';

afterEach(cleanup);

function Field({ onSubmit }: { onSubmit: () => void }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <textarea aria-label="message" onKeyDown={submitOnEnter} />
    </form>
  );
}

test('Enter sends; Shift+Enter and Enter during input-method composition do not', () => {
  const sent = vi.fn();
  render(<Field onSubmit={sent} />);
  const field = screen.getByLabelText('message');

  fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
  fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(field, { key: 'a' });
  expect(sent).not.toHaveBeenCalled();

  fireEvent.keyDown(field, { key: 'Enter' });
  expect(sent).toHaveBeenCalledTimes(1);
});
