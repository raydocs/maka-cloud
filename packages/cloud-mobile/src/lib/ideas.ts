import {
  type CloudClient,
  type Conversation,
  displayText,
  type ProjectView,
} from '@maka-cloud/client';
import { useEffect, useState } from 'react';
import type { Key } from './strings';

type Say = (key: Key, params?: Record<string, string | number>) => string;

/**
 * Something to start with. A tap either fills the composer (`fill`), never sending it, or opens a
 * conversation the person already has (`open`). `id` is the fixed device-test name.
 */
export type Idea = { id: string; label: string } & (
  | { fill: string; open?: undefined }
  | { open: string; fill?: undefined }
);

/** The fixed ideas, for someone with no project and no earlier conversation. */
const FIXED = ['home.idea.1', 'home.idea.2', 'home.idea.3'] as const;

/**
 * Ideas from the person's own work: fix the tests in their first project, review the pull requests
 * in their second (or the same one), and pick up their latest named conversation (not the one open
 * now). With none of those, the three fixed ideas.
 */
export function startersFor(
  projects: readonly ProjectView[] | undefined,
  conversations: readonly Conversation[],
  openNow: string | undefined,
  say: Say,
): Idea[] {
  const ideas: Idea[] = [];
  const first = projects?.[0];
  const second = projects?.[1] ?? first;
  if (first) {
    const label = say('idea.fix', { repo: displayText(first.repo) });
    ideas.push({ id: 'idea-fix', label, fill: label });
  }
  if (second) {
    const label = say('idea.review', { repo: displayText(second.repo) });
    ideas.push({ id: 'idea-review', label, fill: label });
  }
  const latest = [...conversations]
    .reverse()
    .find((c) => c.conversationId !== openNow && c.title && displayText(c.title).trim());
  if (latest?.title)
    ideas.push({
      id: 'idea-continue',
      label: say('idea.continue', { title: displayText(latest.title) }),
      open: latest.conversationId,
    });
  if (ideas.length > 0) return ideas;
  return FIXED.map((key) => ({ id: key, label: say(key), fill: say(key) }));
}

/** One read of the projects per signed-in client, shared by the screens that offer ideas. */
const read = new WeakMap<CloudClient, Promise<ProjectView[] | undefined>>();

/**
 * The person's projects, or undefined until read and when they cannot be (a server without
 * projects, a failed read): the ideas then come from the conversations or the fixed set.
 */
export function useProjects(client: CloudClient): ProjectView[] | undefined {
  const [projects, setProjects] = useState<ProjectView[] | undefined>();
  useEffect(() => {
    let current = true;
    let once = read.get(client);
    if (!once) {
      once = client.listProjects().catch(() => {
        // A failed read is tried again next time an idea list is shown.
        read.delete(client);
        return undefined;
      });
      read.set(client, once);
    }
    void once.then((list) => {
      if (current) setProjects(list);
    });
    return () => {
      current = false;
    };
  }, [client]);
  return projects;
}
