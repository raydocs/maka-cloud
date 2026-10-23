import type { Language, QuotaReason } from './contract';

export function quotaReason(value: unknown): QuotaReason | undefined {
  if (typeof value !== 'object' || value === null) return;
  const q = value as QuotaReason;
  if (
    !['task', 'run', 'day', 'month', 'service'].includes(q.scope) ||
    !['wait', 'raise_limit', 'ask_owner'].includes(q.nextStep) ||
    !(
      q.resetsAt === null ||
      (typeof q.resetsAt === 'number' &&
        Number.isFinite(q.resetsAt) &&
        q.resetsAt > 0 &&
        q.resetsAt <= 8.64e15)
    )
  )
    return;
  if (q.scope === 'service') {
    if (
      q.usedUsd !== undefined ||
      q.limitUsd !== undefined ||
      q.resetsAt === null ||
      q.nextStep !== 'wait'
    )
      return;
  } else if (
    !Number.isFinite(q.usedUsd) ||
    q.usedUsd < 0 ||
    !Number.isFinite(q.limitUsd) ||
    q.limitUsd < 0
  )
    return;
  return q;
}

export function quotaText(q: QuotaReason, language: Language = 'zh-Hans', advice = true): string {
  const time =
    q.resetsAt === null
      ? null
      : new Intl.DateTimeFormat({ en: 'en-US', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' }[language], {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(q.resetsAt);
  const past = q.resetsAt !== null && q.resetsAt <= Date.now();
  if (q.scope === 'service') {
    if (language === 'en')
      return past
        ? `The service was limited until ${time}.`
        : `The service has reached today's limit.${advice ? ` Try again after ${time}.` : ''}`;
    if (language === 'zh-Hant')
      return past
        ? `服務先前受到用量限制，已於 ${time} 解除。`
        : `服務已達到今日用量上限。${advice ? `請於 ${time} 之後再試。` : ''}`;
    return past
      ? `服务此前受到用量限制，已于 ${time} 解除。`
      : `服务已达到今日用量上限。${advice ? `请于 ${time} 之后重试。` : ''}`;
  }
  const used = `$${q.usedUsd.toFixed(2)}`;
  const limit = `$${q.limitUsd.toFixed(2)}`;
  if (language === 'en') {
    const scope = { task: 'Task', run: 'Run', day: 'Daily', month: 'Monthly' }[q.scope];
    const summary = `${scope} spending limit: ${used} of ${limit}.${time ? (past ? ` Was limited until ${time}.` : ` Resets at ${time}.`) : ' No automatic reset.'}`;
    const next =
      q.nextStep === 'raise_limit'
        ? 'Raise the limit in settings.'
        : q.nextStep === 'wait' && time
          ? `Wait until ${time}.`
          : 'Ask the workspace owner to raise the limit.';
    return advice && !past ? `${summary} ${next}` : summary;
  }
  if (language === 'zh-Hant') {
    const scope = { task: '單次任務', run: '單次執行', day: '每日', month: '每月' }[q.scope];
    const summary = `${scope}用量上限：已使用 ${used}，上限 ${limit}。${time ? (past ? `先前的限制已於 ${time} 解除。` : `於 ${time} 重設。`) : '不會自動重設。'}`;
    const next =
      q.nextStep === 'raise_limit'
        ? '請在設定中提高上限。'
        : q.nextStep === 'wait' && time
          ? `請等到 ${time}。`
          : '請聯絡工作區擁有者提高上限。';
    return advice && !past ? `${summary}${next}` : summary;
  }
  const scope = { task: '单次任务', run: '单次运行', day: '每日', month: '每月' }[q.scope];
  const summary = `${scope}用量上限：已使用 ${used}，上限 ${limit}。${time ? (past ? `此前的限制已于 ${time} 解除。` : `于 ${time} 重置。`) : '不会自动重置。'}`;
  const next =
    q.nextStep === 'raise_limit'
      ? '请在设置中提高上限。'
      : q.nextStep === 'wait' && time
        ? `请等到 ${time}。`
        : '请联系工作区所有者提高上限。';
  return advice && !past ? `${summary}${next}` : summary;
}

// Parse our fixed en-US presentation explicitly: phone engines need not accept localized
// dates in Date.parse. Constructing a local date preserves the viewer's timezone.
function englishReset(text: string): number {
  const match =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)$/u.exec(
      text,
    );
  if (!match) return NaN;
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ].indexOf(match[1] ?? '');
  const hour = (Number(match[4]) % 12) + (match[7] === 'PM' ? 12 : 0);
  return new Date(
    Number(match[3]),
    month,
    Number(match[2]),
    hour,
    Number(match[5]),
    Number(match[6]),
  ).getTime();
}

/** Re-localizes the fixed English presentation returned by errorText; never model prose. */
export function localizedQuotaText(text: string, language: Language): string | undefined {
  const service =
    /^The service (?:has reached today's limit\. Try again after (.+)|was limited until (.+))\.$/u.exec(
      text,
    );
  if (service) {
    const quota = quotaReason({
      scope: 'service',
      resetsAt: englishReset(service[1] ?? service[2] ?? ''),
      nextStep: 'wait',
    });
    return quota && quotaText(quota, language);
  }
  const match =
    /^(Task|Run|Daily|Monthly) spending limit: \$(\d+\.\d+) of \$(\d+\.\d+)\. (?:Resets at (.+?)\.|Was limited until (.+?)\.|No automatic reset\.)(?: (Raise the limit in settings\.|Wait until .+\.|Ask the workspace owner to raise the limit\.))?$/u.exec(
      text,
    );
  if (!match) return;
  const quota = quotaReason({
    scope: { Task: 'task', Run: 'run', Daily: 'day', Monthly: 'month' }[match[1] ?? ''],
    usedUsd: Number(match[2]),
    limitUsd: Number(match[3]),
    resetsAt: match[4] || match[5] ? englishReset(match[4] ?? match[5] ?? '') : null,
    nextStep: match[6]?.startsWith('Raise')
      ? 'raise_limit'
      : match[6]?.startsWith('Wait') || match[5]
        ? 'wait'
        : 'ask_owner',
  });
  return quota && quotaText(quota, language, match[6] !== undefined);
}
