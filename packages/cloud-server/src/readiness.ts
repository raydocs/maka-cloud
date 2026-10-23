export type SetupStep = 'language' | 'project' | 'model' | 'notifications' | 'conversation';
export interface SetupCard {
  id: SetupStep;
  action: 'settings' | 'projects' | 'chat';
}
export interface Readiness {
  completed: SetupStep[];
  cards: SetupCard[];
}
export type ReadinessFacts = Record<SetupStep, boolean>;
const steps: SetupCard[] = [
  { id: 'language', action: 'settings' },
  { id: 'project', action: 'projects' },
  { id: 'model', action: 'settings' },
  { id: 'notifications', action: 'settings' },
  { id: 'conversation', action: 'chat' },
];
/** Stable order, actual completion wins over dismissal; later lasts one day. */
export function accountReadiness(
  facts: ReadinessFacts,
  later: ReadonlyMap<string, number>,
  now: number,
): Readiness {
  return {
    completed: steps.filter(({ id }) => facts[id]).map(({ id }) => id),
    cards: steps.filter(({ id }) => !facts[id] && (later.get(id) ?? 0) <= now),
  };
}
