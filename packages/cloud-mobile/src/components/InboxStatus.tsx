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
  if (failed)
    return (
      <Card label="Decisions could not be loaded">
        <T kind="muted">Decisions could not be loaded.</T>
        <PillButton label="Try again" onPress={onRetry} />
      </Card>
    );
  if (loaded)
    return (
      <Card label="Nothing needs you">
        <T kind="muted">Nothing needs you. Start something below.</T>
      </Card>
    );
  return (
    <Card label="Loading">
      <SkeletonLine width="60%" />
      <SkeletonLine />
      <SkeletonLine width="80%" />
    </Card>
  );
}
