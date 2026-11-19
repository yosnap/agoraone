import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { ActionIcon, type ActionIconName } from './action-icons';
import './action-button.css';

/** The colour of an action: neutral (grey), primary (filled, the confirming action), info (blue: view, edit),
 * success (green: run, create, save), warning (amber: pause) and danger (red: delete, remove, forget). */
export type ActionTone = 'neutral' | 'primary' | 'info' | 'success' | 'warning' | 'danger';

/** The tone each icon has when the caller does not choose one, so the same action looks the same everywhere. */
const TONE: Partial<Record<ActionIconName, ActionTone>> = {
  pause: 'warning', play: 'success', edit: 'info', trash: 'danger', eye: 'info', file: 'info', plus: 'success', save: 'success',
  check: 'success', send: 'primary', archive: 'warning', close: 'neutral',
};

export type ActionButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: ActionIconName;
  /** The visible text and, with `iconOnly`, the accessible name and tooltip. */
  label: string;
  tone?: ActionTone;
  iconOnly?: boolean;
  /** Shown instead of `label` while the action runs («Abriendo…»); the icon stays. */
  busyLabel?: string | false;
  small?: boolean;
};

/** The standard button of an action across AgoraOne: an icon and a colour that say what it does, with its label. An
 * icon-only button keeps its name for screen readers and as a tooltip. It never confirms anything by itself: a
 * destructive action still asks first where it did before. */
export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  { icon, label, tone, iconOnly = false, busyLabel, small = false, className, type = 'button', title, ...rest }, ref) {
  const classes = ['button', 'action-button', `tone-${tone ?? TONE[icon] ?? 'neutral'}`, iconOnly && 'icon-only', small && 'small', className]
    .filter(Boolean).join(' ');
  return <button ref={ref} type={type} className={classes} aria-label={iconOnly ? label : undefined} title={title ?? (iconOnly ? label : undefined)} {...rest}>
    <ActionIcon name={icon}/>{!iconOnly && <span>{busyLabel || label}</span>}
  </button>;
});
