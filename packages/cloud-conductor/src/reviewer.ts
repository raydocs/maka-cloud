/**
 * A brief that asks a runner to judge another task's claims says so in its leading directives:
 *
 *     maka-inputs: tsk_drafter report.json sources
 *     maka-artifacts: judgments.json
 *
 * The runners read these lines and nothing else as requests. The conductor reads the same lines
 * to see when a delegation is a reviewer's, because a reviewer must not be the runner that
 * drafted what it reviews.
 */
const INPUTS = 'maka-inputs:';
const ARTIFACTS = 'maka-artifacts:';
export const JUDGMENTS_FILE = 'judgments.json';

export interface ReviewLinks {
  /** Tasks whose runner must differ from the runner of this delegation. */
  others: string[];
}

/**
 * Which tasks the delegation's runner must differ from, read from the brief's leading directives:
 * the drafts a reviewer is asked to judge (the brief asks for `judgments.json` as an artifact),
 * and the tasks whose `judgments.json` a brief takes as input, since the runner that uses
 * judgments must not be the one that wrote them.
 */
export function reviewLinksOf(brief: string): ReviewLinks {
  const sources: string[] = [];
  const judges: string[] = [];
  let asksForJudgments = false;
  const lines = brief.split('\n').map((line) => line.replace(/\r$/u, ''));
  let index = 0;
  while (index < lines.length && (lines[index] as string).trim() === '') index++;
  for (; index < lines.length; index++) {
    const line = lines[index] as string;
    if (line.startsWith(INPUTS)) {
      const [, source, ...paths] = line.slice(INPUTS.length).split(' ');
      if (!source) continue;
      if (!sources.includes(source)) sources.push(source);
      if (paths.includes(JUDGMENTS_FILE) && !judges.includes(source)) judges.push(source);
    } else if (line.startsWith(ARTIFACTS)) {
      if (line.slice(ARTIFACTS.length).split(' ').includes(JUDGMENTS_FILE)) asksForJudgments = true;
    } else {
      break;
    }
  }
  return { others: asksForJudgments ? [...new Set([...sources, ...judges])] : judges };
}
