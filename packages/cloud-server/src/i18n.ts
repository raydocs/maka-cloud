/**
 * The words the server itself says to a person, in each language it speaks. Small and typed on
 * purpose: every entry exists in every language (the `Messages` type makes a missing one a build
 * error), and a parameter is always a value the server already shows, never new text.
 *
 * Option labels and ids of inbox items are not here: they stay English in the data, and the apps
 * translate the ids they know.
 */

export const LANGUAGES = ['zh-Hans', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

/** What a person who never chose gets: the product launches to Chinese-speaking users. */
export const DEFAULT_LANGUAGE: Language = 'zh-Hans';

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * The language a request asks for at sign-up: English when the first entry of `Accept-Language`
 * is English, else the default. Only the first entry counts, so a browser set to Chinese that
 * also lists English stays Chinese.
 */
export function languageFromAcceptLanguage(header: string | string[] | undefined): Language {
  const value = Array.isArray(header) ? header[0] : header;
  const first = value?.split(',')[0]?.trim().toLowerCase() ?? '';
  return first === 'en' || first.startsWith('en-') || first.startsWith('en;')
    ? 'en'
    : DEFAULT_LANGUAGE;
}

type Checks = 'green' | 'red' | 'pending' | 'none';

export interface Messages {
  signInMail: { subject: string; text: (code: string) => string };
  push: {
    taskFinished: { title: string; body: string };
    spendAlert: { title: string; body: string };
  };
  note: {
    pullRequestMerged: (repo: string, number: number, checks: Checks) => string;
    checksFailed: (repo: string, number: number) => string;
  };
  /** Inbox asks the supervisor builds from a fixed sentence. Titles and details arrive clipped and quote-safe. */
  ask: {
    stall: (title: string, minutes: number) => string;
    failedTwice: (title: string, count: number, reason: string) => string;
    lowConfidence: (title: string, summary: string) => string;
    finished: (
      title: string,
      checked: 'passed' | 'not_checked' | undefined,
      detail: string,
    ) => string;
    failed: (title: string, detail: string) => string;
    verificationFailed: (title: string, count: number, detail: string, more: number) => string;
    verificationIncomplete: (title: string, detail: string) => string;
    /** `label` is the card kind's English words; a language without them says "this kind". */
    suggestionOffer: (count: number, label: string, repo: string) => string;
  };
  /** Prefixes of the conversation notice that tells the person an item needs them. */
  needsYou: { one: (ask: string) => string; many: (count: number, list: string) => string };
}

/** Agent-written text, quoted. An empty title says it has none. */
function quote(text: string, untitled: string): string {
  return text === '' ? untitled : `“${text}”`;
}

const en: Messages = {
  signInMail: {
    subject: 'Your sign-in code',
    text: (code) =>
      `Your sign-in code is ${code}. It works once, for ten minutes, in the app or page that asked for it. If you did not ask, ignore this mail.`,
  },
  push: {
    taskFinished: {
      title: 'Your background task has finished',
      body: 'Open Maka to review the result.',
    },
    spendAlert: { title: 'Spending is high today', body: 'Open Maka to see where it went.' },
  },
  note: {
    pullRequestMerged: (repo, number, checks) =>
      `PR #${number} in ${repo} merged${
        checks === 'none'
          ? ''
          : `, ${{ green: 'CI green', red: 'CI red', pending: 'CI still running' }[checks]}`
      }.`,
    checksFailed: (repo, number) => `Checks failed on PR #${number} in ${repo}.`,
  },
  ask: {
    stall: (title, minutes) =>
      `The task ${quote(title, '(untitled)')} has had no progress for ${minutes} minutes.`,
    failedTwice: (title, count, reason) =>
      `The step ${quote(title, '(untitled)')} has failed ${count} times. Last reason: ${quote(reason, '(untitled)')}`,
    lowConfidence: (title, summary) =>
      `The result of ${quote(title, '(untitled)')} came back with low confidence: ${quote(summary, '(untitled)')}`,
    finished: (title, checked, detail) =>
      `${quote(title, '(untitled)')} finished${
        checked === 'passed'
          ? ' (independently checked)'
          : checked === 'not_checked'
            ? ' (not independently checked)'
            : ''
      }: ${quote(detail, '(untitled)')}`,
    failed: (title, detail) =>
      `${quote(title, '(untitled)')} failed: ${quote(detail, '(untitled)')}`,
    verificationFailed: (title, count, detail, more) =>
      `The independent check of ${quote(title, '(untitled)')} found ${count} ${count === 1 ? 'problem' : 'problems'}: ${detail}${more > 0 ? ` (and ${more} more)` : ''}`,
    verificationIncomplete: (title, detail) =>
      `The independent check of ${quote(title, '(untitled)')} could not be completed, so the result is not verified: ${detail}`,
    suggestionOffer: (count, label, repo) =>
      `${count} suggestions in a row to ${label} on ${repo} went unanswered. Stop suggesting them?`,
  },
  needsYou: {
    one: (ask) => `Needs you: ${ask}`,
    many: (count, list) => `Needs you (${count} items):\n${list}`,
  },
};

const UNTITLED_ZH = '（未命名）';

const zhHans: Messages = {
  signInMail: {
    subject: '你的登录验证码',
    text: (code) =>
      `你的登录验证码是 ${code}。它只能用一次，10 分钟内有效，请在发起请求的应用或网页中输入。如果不是你本人操作，请忽略这封邮件。`,
  },
  push: {
    taskFinished: { title: '后台任务已完成', body: '打开 Maka 查看结果。' },
    spendAlert: { title: '今天的花费偏高', body: '打开 Maka 查看明细。' },
  },
  note: {
    pullRequestMerged: (repo, number, checks) =>
      `${repo} 的 PR #${number} 已合并${
        checks === 'none'
          ? ''
          : `，${{ green: 'CI 已通过', red: 'CI 未通过', pending: 'CI 仍在运行' }[checks]}`
      }。`,
    checksFailed: (repo, number) => `${repo} 的 PR #${number} 检查未通过。`,
  },
  ask: {
    stall: (title, minutes) => `任务${quote(title, UNTITLED_ZH)}已经 ${minutes} 分钟没有进展。`,
    failedTwice: (title, count, reason) =>
      `步骤${quote(title, UNTITLED_ZH)}已失败 ${count} 次。最近一次的原因：${quote(reason, UNTITLED_ZH)}`,
    lowConfidence: (title, summary) =>
      `${quote(title, UNTITLED_ZH)}的结果可信度较低：${quote(summary, UNTITLED_ZH)}`,
    finished: (title, checked, detail) =>
      `${quote(title, UNTITLED_ZH)}已完成${
        checked === 'passed'
          ? '（已独立核查）'
          : checked === 'not_checked'
            ? '（未经独立核查）'
            : ''
      }：${quote(detail, UNTITLED_ZH)}`,
    failed: (title, detail) => `${quote(title, UNTITLED_ZH)}失败了：${quote(detail, UNTITLED_ZH)}`,
    verificationFailed: (title, count, detail, more) =>
      `对${quote(title, UNTITLED_ZH)}的独立核查发现 ${count} 个问题：${detail}${more > 0 ? `（另有 ${more} 个）` : ''}`,
    verificationIncomplete: (title, detail) =>
      `对${quote(title, UNTITLED_ZH)}的独立核查没能完成，结果未经核实：${detail}`,
    suggestionOffer: (count, _label, repo) =>
      `${repo} 上连续 ${count} 条这类建议没有得到回应。要停止这类建议吗？`,
  },
  needsYou: {
    one: (ask) => `需要你处理：${ask}`,
    many: (count, list) => `需要你处理（${count} 项）：\n${list}`,
  },
};

export const MESSAGES: Readonly<Record<Language, Messages>> = { en, 'zh-Hans': zhHans };

/** The person's words, or English for a language the server does not have. */
export function messages(language: string | undefined): Messages {
  return isLanguage(language) ? MESSAGES[language] : MESSAGES.en;
}

/**
 * What the conversational agent's system prompt adds for a person's language, or nothing when the
 * prompt already fits (English). It goes into the system prompt of a new conversation only; the
 * history of a conversation is never edited.
 *
 * Task briefs, commit messages, pull request titles and code stay English: the runners work in
 * shared repositories, and the coding agents' own prompts are left as they are.
 */
export function languageInstruction(language: Language): string | undefined {
  if (language !== 'zh-Hans') return undefined;
  return `Language: the person you work for reads Simplified Chinese. Reply to them in Simplified Chinese unless they write to you in another language; then reply in theirs. Questions and notes you show them follow the same rule. Messages the app writes on their behalf (such as those starting with "From my inbox:") are not the person writing, so they do not change the reply language. Keep code, commands, file names, URLs and quoted text exactly as they are. Write the briefs you delegate in English, and keep commit messages, pull request titles and code in English unless the repository's own conventions say otherwise.`;
}
