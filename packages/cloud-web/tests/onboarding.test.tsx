import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Onboarding, onboardingSkipped } from '../src/Onboarding';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('a starter needs a repository written as owner/name, then fills the sentence once', () => {
  const picked: string[] = [];
  render(<Onboarding onPick={(sentence) => picked.push(sentence)} onSkip={() => {}} />);
  const card = screen.getByRole('region', { name: 'Get started' });
  const starters = within(card)
    .getAllByRole('button')
    .filter((b) => b.className === 'starter');
  expect(starters).toHaveLength(3);
  expect(starters.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);

  const repo = within(card).getByLabelText('Repository');
  fireEvent.change(repo, { target: { value: 'not a repo' } });
  expect(within(card).getByText(/Write it as owner\/name/u)).toBeTruthy();

  // A pasted GitHub address is read as owner/name.
  fireEvent.change(repo, { target: { value: 'https://github.com/acme/widgets.git' } });
  const fix = within(card).getByRole('button', { name: /Fix the failing test in acme\/widgets/u });
  expect((fix as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(fix);
  expect(picked).toEqual(['Fix the failing test in acme/widgets and open a pull request.']);
});

test('skip is remembered in this browser, and a browser without storage still skips', () => {
  const onSkip = vi.fn();
  const { unmount } = render(<Onboarding onPick={() => {}} onSkip={onSkip} />);
  expect(onboardingSkipped()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
  expect(onSkip).toHaveBeenCalledTimes(1);
  expect(onboardingSkipped()).toBe(true);
  unmount();

  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  });
  expect(onboardingSkipped()).toBe(false);
  const skip = vi.fn();
  render(<Onboarding onPick={() => {}} onSkip={skip} />);
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
  expect(skip).toHaveBeenCalledTimes(1);
});
