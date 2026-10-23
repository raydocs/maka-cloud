import type { Language, QuotaReason } from './contract';

export function quotaReason(value: unknown): QuotaReason | undefined {
  if (typeof value !== 'object' || value === null) return;
  const q = value as QuotaReason;
  if (
    !['task', 'day', 'month'].includes(q.scope) ||
    !['wait', 'raise_limit', 'ask_owner'].includes(q.nextStep) ||
    !Number.isFinite(q.usedUsd) ||
    q.usedUsd < 0 ||
    !Number.isFinite(q.limitUsd) ||
    q.limitUsd < 0 ||
    !(
      q.resetsAt === null ||
      (typeof q.resetsAt === 'number' &&
        Number.isFinite(q.resetsAt) &&
        q.resetsAt > 0 &&
        q.resetsAt <= 8.64e15)
    )
  )
    return;
  return q;
}

export function quotaText(q: QuotaReason, language: Language = 'zh-Hans', advice = true): string {
  const used = `$${q.usedUsd.toFixed(2)}`;
  const limit = `$${q.limitUsd.toFixed(2)}`;
  const time = q.resetsAt === null ? null : new Date(q.resetsAt).toISOString();
  if (language === 'en') {
    const scope = { task: 'Task', day: 'Daily', month: 'Monthly' }[q.scope];
    const summary = `${scope} spending limit: ${used} of ${limit}.${time ? ` Resets at ${time}.` : ' No automatic reset.'}`;
    const next =
      q.nextStep === 'raise_limit'
        ? 'Raise the limit in settings.'
        : q.nextStep === 'wait' && time
          ? `Wait until ${time}.`
          : 'Ask the workspace owner to raise the limit.';
    return advice ? `${summary} ${next}` : summary;
  }
  if (language === 'zh-Hant') {
    const scope = { task: '單次任務', day: '每日', month: '每月' }[q.scope];
    const summary = `${scope}用量上限：已使用 ${used}，上限 ${limit}。${time ? `於 ${time} 重設。` : '不會自動重設。'}`;
    const next =
      q.nextStep === 'raise_limit'
        ? '請在設定中提高上限。'
        : q.nextStep === 'wait' && time
          ? `請等到 ${time}。`
          : '請聯絡工作區擁有者提高上限。';
    return advice ? `${summary}${next}` : summary;
  }
  const scope = { task: '单次任务', day: '每日', month: '每月' }[q.scope];
  const summary = `${scope}用量上限：已使用 ${used}，上限 ${limit}。${time ? `于 ${time} 重置。` : '不会自动重置。'}`;
  const next =
    q.nextStep === 'raise_limit'
      ? '请在设置中提高上限。'
      : q.nextStep === 'wait' && time
        ? `请等到 ${time}。`
        : '请联系工作区所有者提高上限。';
  return advice ? `${summary}${next}` : summary;
}

/** Re-localizes the fixed English presentation returned by errorText; never model prose. */
export function localizedQuotaText(text: string, language: Language): string | undefined {
  const match =
    /^(Task|Daily|Monthly) spending limit: \$(\d+\.\d+) of \$(\d+\.\d+)\. (?:Resets at (\S+)\.|No automatic reset\.) (Raise the limit in settings\.|Wait until \S+\.|Ask the workspace owner to raise the limit\.)$/u.exec(
      text,
    );
  if (!match) return;
  const quota = quotaReason({
    scope: match[1] === 'Task' ? 'task' : match[1] === 'Daily' ? 'day' : 'month',
    usedUsd: Number(match[2]),
    limitUsd: Number(match[3]),
    resetsAt: match[4] ? Date.parse(match[4]) : null,
    nextStep: match[5]?.startsWith('Raise')
      ? 'raise_limit'
      : match[5]?.startsWith('Wait')
        ? 'wait'
        : 'ask_owner',
  });
  return quota && quotaText(quota, language);
}
