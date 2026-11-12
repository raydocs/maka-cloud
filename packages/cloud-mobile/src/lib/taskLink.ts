import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useWorkspace } from './session';

/**
 * A task a notification or a link opened (`/chat?task=<id>&conversation=<id>`): its conversation is
 * opened, found from the task when the link does not name it, and the task is handed back for Chat
 * to bring into view. A conversation is opened only if the server lists it as this account's; a
 * task the server does not show this account leaves Chat as it was.
 */
export function useTaskLink(): { focus: string | undefined; done: () => void } {
  const { task, conversation } = useLocalSearchParams<{ task?: string; conversation?: string }>();
  const { client, conversations, open, started } = useWorkspace();
  const router = useRouter();
  const [focus, setFocus] = useState<string | undefined>();
  // A new link, not a new list of conversations, starts this.
  useEffect(() => {
    if (!task) return;
    let live = true;
    void (async () => {
      const conversationId = conversation ?? (await client.taskConversation(task)).conversationId;
      if (!live) return;
      if (conversations.some((c) => c.conversationId === conversationId)) open(conversationId);
      else {
        // Started on another device since this one signed in.
        const { conversations: listed } = await client.listConversations();
        const found = listed.find((c) => c.conversationId === conversationId);
        if (!live || !found) return;
        started(found);
      }
      setFocus(task);
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [task, conversation]);
  return {
    focus,
    done: () => {
      setFocus(undefined);
      router.setParams({ task: undefined, conversation: undefined });
    },
  };
}
