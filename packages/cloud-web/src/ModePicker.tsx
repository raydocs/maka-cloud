import { useRef } from 'react';
import { type Mode, MODES } from '@maka-cloud/client';

const LABELS: Record<Mode, { label: string; hint: string }> = {
  quick: { label: 'Quick', hint: 'Small, well-understood work: fast and cheap.' },
  standard: { label: 'Standard', hint: 'The usual: careful work with an independent review.' },
  deep: { label: 'Deep', hint: 'Hard or risky work: the most care, and the most spend.' },
};

/**
 * How much care the next piece of work gets. "Let it decide" sends no mode: the agent picks from
 * the size of the work and the budget. A pick applies when the message starts new work.
 *
 * Folded into one small chip that names the current choice; it opens to the four choices, each
 * with a line on what it means, and closes on a pick. Most messages never need it.
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
  const menu = useRef<HTMLDetailsElement>(null);
  const options: Array<{ value: Mode | undefined; label: string; hint: string }> = [
    {
      value: undefined,
      label: 'Let it decide',
      hint: 'It picks from the size of the work and your budget.',
    },
    ...MODES.map((mode) => ({ value: mode, ...LABELS[mode] })),
  ];
  const current = options.find((option) => option.value === value) ?? options[0];
  return (
    <details className="mode-menu" ref={menu}>
      <summary aria-label={`How much care: ${current?.label}`}>
        {current?.label}
        <span aria-hidden="true" className="mode-caret">
          ▾
        </span>
      </summary>
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
                onChange={() => {
                  onChange(option.value);
                  if (menu.current) menu.current.open = false;
                }}
                aria-describedby={`${id}-hint`}
              />
              <label htmlFor={id}>{option.label}</label>
              <span id={`${id}-hint`} className="mode-hint">
                {option.hint}
              </span>
            </span>
          );
        })}
      </fieldset>
    </details>
  );
}
