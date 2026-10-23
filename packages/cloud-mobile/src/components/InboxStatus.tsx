import { useT } from '@/lib/i18n';
import { Card, PillButton, SkeletonLine, T } from './ui';

/**
 * What stands where the decisions would be when there are none: bars while they are being read, a
 * retry when they could not be (even if an earlier read was empty), and a calm line when nothing waits. Never an empty space.
 */
export function InboxStatus({
  loaded,
  failed,
  onRetry,
}: {
  loaded: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const { t: say } = useT();
  if (failed)
    return (
      <Card label={say('inbox.failed')}>
        <T kind="muted">{say('inbox.failed')}</T>
        <PillButton label={say('common.tryAgain')} id="Try again" onPress={onRetry} />
      </Card>
    );
  if (loaded)
    return (
      <Card label={say('inbox.none.label')}>
        <T kind="muted">{say('inbox.none')}</T>
      </Card>
    );
  return (
    <Card label={say('common.loading')}>
      <SkeletonLine width="60%" />
      <SkeletonLine />
      <SkeletonLine width="80%" />
    </Card>
  );
}
