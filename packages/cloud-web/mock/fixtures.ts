import type { Artifact, Conversation, Events, FeedEvent, Manifest } from '../src/contract';

export const conversation: Conversation = {
  conversationId: 'cnv_demo',
  title: 'A thoughtful launch for Fieldnotes',
  createdAt: 1792400000000,
};
export const question: Events['conductor.question'] = {
  conversationId: conversation.conversationId,
  runId: 'run_demo',
  questionId: 'q_direction',
  reason: 'taste',
  question: 'Which direction feels right for the launch?',
  // Deliberately unsorted: the client must put the recommendation first.
  options: [
    { id: 'bold', label: 'A bold, announcement-led launch' },
    { id: 'quiet', label: 'A quieter launch, built around the story' },
  ],
  recommended: 'quiet',
};
export const manifest: Manifest = {
  summary: 'The launch brief is ready for your review.',
  done: ['Compared launch approaches', 'Prepared the first changes'],
  notDone: ['Nothing published'],
  knownIssues: [],
  confidence: 'high',
  artifacts: ['report', 'diff', 'pr'],
};
export const artifactFixtures: Record<string, Artifact> = {
  report: {
    kind: 'report',
    title: 'Launch research brief',
    content:
      '# A launch with room to breathe\n\nLead with the story, not a feature list.\n\n1. Share the problem that started Fieldnotes.\n2. Invite a small group to try it.\n3. Publish what you learn.\n\nSources and verification\nThis is a local demonstration fixture, not live research.',
  },
  diff: {
    kind: 'diff',
    title: 'A warmer introduction',
    content:
      '--- a/landing.tsx\n+++ b/landing.tsx\n@@ -1 +1 @@\n-<h1>All your notes.</h1>\n+<h1>A little space for your next idea.</h1>',
  },
  pr: {
    kind: 'pr',
    title: 'Review the launch changes',
    url: 'https://github.com/example/fieldnotes/pull/12',
  },
};

export function seedEvents(): FeedEvent[] {
  const events: FeedEvent[] = [];
  let taskSequence = 0;
  function add<K extends keyof Events>(kind: K, data: Events[K]) {
    events.push({ id: events.length + 1, kind, data } as FeedEvent);
  }
  const id = conversation.conversationId;
  add('conversation.created', {
    conversationId: id,
    title: conversation.title,
    at: conversation.createdAt,
  });
  add('message.posted', {
    conversationId: id,
    messageId: 'msg_first',
    role: 'user',
    text: 'Help me put together a thoughtful launch for Fieldnotes. I’d like a research brief and a first pass at the landing page.',
    at: conversation.createdAt,
  });
  add('conductor.message', {
    conversationId: id,
    runId: 'run_demo',
    text: 'Let’s make it feel like an invitation, not an announcement. I’m looking at a few approaches and preparing a first pass for you to review. Nothing will be published without your say-so.',
  });
  const task = (event: Events['task.event']['event']) =>
    add('task.event', {
      conversationId: id,
      seq: ++taskSequence,
      at: conversation.createdAt + events.length * 1000,
      event,
    });
  task({
    type: 'task_created',
    taskId: 'task_launch',
    sessionId: 'session_demo',
    runner: 'fixture-runner',
    title: 'Prepare the launch',
    mode: 'async',
  });
  task({ type: 'task_started', taskId: 'task_launch' });
  task({
    type: 'task_progress',
    taskId: 'task_launch',
    note: 'Bringing the story and the first changes together.',
  });
  task({
    type: 'task_created',
    taskId: 'task_research',
    parentTaskId: 'task_launch',
    sessionId: 'session_demo',
    runner: 'fixture-runner',
    title: 'Find the right approach',
    mode: 'async',
  });
  task({ type: 'task_started', taskId: 'task_research' });
  task({ type: 'task_succeeded', taskId: 'task_research', manifest });
  task({
    type: 'task_created',
    taskId: 'task_page',
    parentTaskId: 'task_launch',
    sessionId: 'session_demo',
    runner: 'fixture-runner',
    title: 'Shape the landing page',
    mode: 'async',
  });
  task({ type: 'task_started', taskId: 'task_page' });
  task({
    type: 'task_progress',
    taskId: 'task_page',
    note: 'Checking the introduction at smaller screen sizes.',
  });
  add('task.cost', { conversationId: id, taskId: 'task_launch', costUsd: 0.23 });
  add('task.cost', { conversationId: id, taskId: 'task_research', costUsd: 0.61 });
  add('task.cost', { conversationId: id, taskId: 'task_page', costUsd: 1.07 });
  add('conductor.question', question);
  return events;
}
