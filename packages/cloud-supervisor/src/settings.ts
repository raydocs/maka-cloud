import { z } from 'zod';
import { ITEM_KINDS } from './types.js';

const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, 'use HH:MM, 24 hours');

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** What the human can change at run time. Stored, so it survives a restart. */
export const SettingsSchema = z
  .object({
    /** A running task with no event for this long is stalled. */
    stallAfterMinutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60),
    /** A queued task that has not started for this long is stalled. */
    queuedStallAfterMinutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60),
    /** Pushes (single or batched) per rolling hour. */
    maxInterruptsPerHour: z.number().int().min(1).max(1000),
    quietHours: z.object({ start: Clock, end: Clock }).strict().nullable(),
    timeZone: z.string().max(64).refine(validTimeZone, 'unknown time zone'),
    /** Local time of the scheduled digest; null turns it off. */
    digestAt: Clock.nullable(),
    /** The most the model checks of finished tasks may spend per day (in `timeZone`). */
    verifierDailyCapUsd: z.number().min(0).max(1000),
    /** Muted kinds still appear in the inbox and the digest; only the push is held back. */
    mutedKinds: z.array(z.enum(ITEM_KINDS)).max(ITEM_KINDS.length),
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  stallAfterMinutes: 30,
  queuedStallAfterMinutes: 10,
  maxInterruptsPerHour: 6,
  quietHours: null,
  timeZone: 'UTC',
  digestAt: '08:00',
  verifierDailyCapUsd: 5,
  mutedKinds: [],
};

export const SettingsPatchSchema = SettingsSchema.partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

interface LocalParts {
  /** `YYYY-MM-DD` in the zone. */
  date: string;
  minutes: number;
}

export function localParts(zone: string, at: number): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

function minutesOf(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/** Quiet hours may wrap midnight (22:00 to 07:00). Equal start and end is never quiet. */
export function inQuietHours(settings: Settings, at: number): boolean {
  if (!settings.quietHours) return false;
  const start = minutesOf(settings.quietHours.start);
  const end = minutesOf(settings.quietHours.end);
  if (start === end) return false;
  const { minutes } = localParts(settings.timeZone, at);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** The digest slot the clock has reached today, as `YYYY-MM-DD`, or undefined before the digest time. */
export function dueDigestSlot(settings: Settings, at: number): string | undefined {
  if (!settings.digestAt) return undefined;
  const { date, minutes } = localParts(settings.timeZone, at);
  return minutes >= minutesOf(settings.digestAt) ? date : undefined;
}
