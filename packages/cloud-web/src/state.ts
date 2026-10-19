import type { FeedEvent, OutboxQuestion, TaskView } from './contract';

export interface ConversationState {
  messages: { id: string; role: 'user' | 'assistant' | 'notice'; text: string }[];
  tasks: Record<string, TaskView>;
  questions: Record<string, OutboxQuestion>;
  answers: Record<string, string>;
  costs: Record<string, number>;
  paused: Record<string, boolean>;
}
export function emptyState(): ConversationState {
  return { messages: [], tasks: {}, questions: {}, answers: {}, costs: {}, paused: {} };
}

export function applyEvent(state: ConversationState, frame: FeedEvent): ConversationState {
  const next = { ...state };
  switch (frame.kind) {
    case 'message.posted':
      if (state.messages.some((m) => m.id === frame.data.messageId)) return state;
      next.messages = [
        ...state.messages,
        { id: frame.data.messageId, role: 'user', text: frame.data.text },
      ];
      break;
    case 'conductor.message':
    case 'conductor.notice':
      next.messages = [
        ...state.messages,
        {
          id: String(frame.id),
          role: frame.kind === 'conductor.message' ? 'assistant' : 'notice',
          text: frame.data.text,
        },
      ];
      break;
    case 'conductor.question':
      next.questions = { ...state.questions, [frame.data.questionId]: frame.data };
      break;
    case 'conductor.answered':
      next.answers = { ...state.answers, [frame.data.questionId]: frame.data.optionId };
      break;
    case 'task.cost':
      if (Number.isFinite(frame.data.costUsd) && frame.data.costUsd >= 0)
        next.costs = { ...state.costs, [frame.data.taskId]: frame.data.costUsd };
      break;
    case 'task.paused':
      next.paused = { ...state.paused, [frame.data.taskId]: frame.data.paused };
      break;
    case 'task.event': {
      const { event, at } = frame.data;
      let task = state.tasks[event.taskId];
      if (event.type === 'task_created') {
        task = {
          taskId: event.taskId,
          parentTaskId: event.parentTaskId,
          title: event.title,
          runner: event.runner,
          state: 'queued',
          createdAt: at,
          progress: [],
          cancelRequested: false,
        };
      } else if (!task) return state;
      else {
        task = { ...task };
        switch (event.type) {
          case 'task_started':
            task.state = 'running';
            task.startedAt = at;
            break;
          case 'task_progress':
            task.progress = [...task.progress, event.note];
            break;
          case 'task_succeeded':
            task.state = 'succeeded';
            task.manifest = event.manifest;
            task.finishedAt = at;
            break;
          case 'task_failed':
            task.state = 'failed';
            task.failureReason = event.reason;
            task.finishedAt = at;
            break;
          case 'task_cancel_requested':
            task.cancelRequested = true;
            break;
          case 'task_cancelled':
            task.state = 'cancelled';
            task.finishedAt = at;
            break;
        }
      }
      next.tasks = { ...state.tasks, [event.taskId]: task };
      break;
    }
  }
  return next;
}
