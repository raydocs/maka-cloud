import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useT } from './i18n';
import { hrefOfNotification } from './links';
import { ACTION, loadPush, readPush, turnOn } from './push';
import { useWorkspace } from './session';

// A notification that arrives while the app is open is shown as a banner, quietly.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/**
 * Mounted with the signed-in sections. While notifications are on, the token is given to the
 * server again (so a phone that changed accounts is this account's). A tap on a notification, or
 * on its "Open", opens the task or the decision it names; "Got it" and "Not now" only put it away
 * and answer nothing.
 */
export function usePushRouting() {
  const { client, server } = useWorkspace();
  const router = useRouter();
  const { t: say } = useT();
  const response = Notifications.useLastNotificationResponse();
  const handled = useRef<string | undefined>(undefined);

  // Once per session, when the sections mount.
  useEffect(() => {
    void loadPush(server).then((record) => {
      if (record?.state !== 'on') return;
      void turnOn(
        client,
        server,
        {
          gotIt: say('push.action.gotIt'),
          notNow: say('push.action.notNow'),
          open: say('push.action.open'),
        },
        false,
      );
    });
  }, []);

  useEffect(() => {
    if (!response) return;
    const { notification, actionIdentifier } = response;
    const id = `${notification.request.identifier}\n${actionIdentifier}`;
    if (handled.current === id) return;
    handled.current = id;
    Notifications.clearLastNotificationResponse();
    if (actionIdentifier === ACTION.gotIt || actionIdentifier === ACTION.notNow) {
      void Notifications.dismissNotificationAsync(notification.request.identifier).catch(() => {});
      return;
    }
    if (
      actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER &&
      actionIdentifier !== ACTION.open
    ) {
      return;
    }
    void readPush(server).then((record) => {
      const tag = record?.state === 'on' ? record.accountTag : undefined;
      router.navigate(hrefOfNotification(notification.request.content.data, tag));
    });
  }, [response, router, server]);
}
