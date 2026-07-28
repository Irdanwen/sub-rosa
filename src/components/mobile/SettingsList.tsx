import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import type { ReactNode } from "react";
import { hapticSelection } from "../../lib/haptics";
import { Switch } from "../ui/Switch";

/**
 * The inset grouped list every iPhone settings screen is built from.
 *
 * Settings used to reuse the desktop `settings-row` grid (label left, control
 * right, in a fixed two-column track), which does not survive a 390 pt column:
 * controls wrapped onto their own lines and long descriptions squeezed into
 * half the width. These primitives are the phone shape instead — a titled
 * group of 44 pt rows, with anything long as a footer under the group rather
 * than beside the label.
 *
 * The pieces are deliberately small: a screen composes them, it does not
 * configure them through a schema.
 */

export function SettingsGroup({
  title,
  footer,
  children,
}: {
  title?: string;
  /** Explanatory copy for the whole group. Long prose belongs here, not in a
   * row, where it would fight the control for width. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mobile-settings-group">
      {title ? <h2 className="mobile-settings-group-title">{title}</h2> : null}
      <div className="mobile-settings-group-body">{children}</div>
      {footer ? <p className="mobile-settings-group-footer">{footer}</p> : null}
    </section>
  );
}

/** A row whose trailing edge holds a control (switch, segmented, button). */
export function SettingsRow({
  label,
  detail,
  children,
  align = "center",
}: {
  /** Omit when the group title already names the control and a row label
   * would just say it a second time. */
  label?: ReactNode;
  /** Secondary line under the label. Keep it to a few words. */
  detail?: ReactNode;
  children?: ReactNode;
  /** "stack" puts the control on its own line, for controls that need the
   * full width (a segmented control, a text field with a button). */
  align?: "center" | "stack";
}) {
  return (
    <div className="mobile-settings-row" data-align={align}>
      {label !== undefined ? (
        <div className="mobile-settings-row-label">
          <span className="mobile-settings-row-title">{label}</span>
          {detail ? <span className="mobile-settings-row-detail">{detail}</span> : null}
        </div>
      ) : null}
      {children ? <div className="mobile-settings-row-control">{children}</div> : null}
    </div>
  );
}

/** A row that pushes a detail screen. `value` is the current state, shown
 * before the chevron the way iOS summarises what is behind the row. */
export function SettingsLinkRow({
  label,
  value,
  onClick,
}: {
  label: ReactNode;
  value?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="mobile-settings-row mobile-settings-link-row"
      onClick={() => {
        hapticSelection();
        onClick();
      }}
    >
      <span className="mobile-settings-row-title">{label}</span>
      <span className="mobile-settings-link-value">
        {value}
        <IconChevronRightSmall size={16} aria-hidden />
      </span>
    </button>
  );
}

/** A row whose control is a switch. The whole row is the hit target. */
export function SettingsToggleRow({
  label,
  detail,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  detail?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <SettingsRow label={label} detail={detail}>
      <Switch
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onCheckedChange={(next) => {
          hapticSelection();
          onChange(next);
        }}
      />
    </SettingsRow>
  );
}

/** A full-width action row (destructive or not) that reads as one tap target. */
export function SettingsActionRow({
  label,
  tone = "default",
  disabled,
  onClick,
}: {
  label: string;
  tone?: "default" | "destructive";
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="mobile-settings-row mobile-settings-action-row"
      data-tone={tone}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
