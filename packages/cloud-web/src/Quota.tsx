import { useEffect, useState } from 'react';
import {
  type CloudClient,
  type QuotaReason,
  type UsageView,
  quotaText,
  type ErrorText,
  errorText,
  Unsupported,
} from '@maka-cloud/client';
import { useT } from './i18n';

export function QuotaNotice({ quota, refusal = true }: { quota: QuotaReason; refusal?: boolean }) {
  const { language } = useT();
  return (
    <p role="status" className={refusal ? 'failure' : 'muted'}>
      {quotaText(quota, language, refusal)}
    </p>
  );
}

export function Usage({ client }: { client: CloudClient }) {
  const { t, shared } = useT();
  const [usage, setUsage] = useState<UsageView>();
  const [error, setError] = useState<ErrorText>('');
  const [unsupported, setUnsupported] = useState(false);
  useEffect(() => {
    let live = true;
    setUsage(undefined);
    setError('');
    setUnsupported(false);
    void client.usage().then(
      (value) => {
        if (live) setUsage(value);
      },
      (failure) => {
        if (!live) return;
        if (failure instanceof Unsupported) setUnsupported(true);
        else setError(errorText(failure));
      },
    );
    return () => {
      live = false;
    };
  }, [client]);
  if (unsupported) return null;
  return (
    <section className="card section-card" aria-label={t('Usage')}>
      <h2>{t('Usage')}</h2>
      {usage
        ? usage.limits.map((limit) => (
            <QuotaNotice key={limit.scope} quota={limit} refusal={false} />
          ))
        : !error && <p>{t('Loading')}</p>}
      {usage?.refusal && <QuotaNotice quota={usage.refusal} />}
      {error && <p role="alert">{shared(error)}</p>}
    </section>
  );
}
