import { type Mode, MODES } from '@maka-cloud/client';

const LABELS: Record<Mode, { label: string; hint: string }> = {
  quick: { label: 'Quick', hint: 'Small, well-understood work: fast and cheap.' },
  standard: { label: 'Standard', hint: 'The usual: careful work with an independent review.' },
  deep: { label: 'Deep', hint: 'Hard or risky work: the most care, and the most spend.' },
};

/**
 * How much care the next piece of work gets. "Let it decide" sends no mode: the agent picks from
 * the size of the work and the budget. A pick applies when the message starts new work.
 */
export function ModePicker({
  value,
  onChange,
  idPrefix,
  disabled = false,
}: {
  value: Mode | undefined;
  onChange: (mode: Mode | undefined) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  const options: Array<{ value: Mode | undefined; label: string; hint: string }> = [
    {
      value: undefined,
      label: 'Let it decide',
      hint: 'It picks from the size of the work and your budget.',
    },
    ...MODES.map((mode) => ({ value: mode, ...LABELS[mode] })),
  ];
  return (
    <fieldset className="mode-picker" disabled={disabled}>
      <legend className="sr-only">How much care this needs</legend>
      {options.map((option) => {
        const id = `${idPrefix}-${option.value ?? 'auto'}`;
        return (
          <span key={id} className="mode-option">
            <input
              type="radio"
              id={id}
              name={`${idPrefix}-mode`}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <label htmlFor={id} title={option.hint}>
              {option.label}
            </label>
          </span>
        );
      })}
    </fieldset>
  );
}
