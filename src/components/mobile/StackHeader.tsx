import { t } from "../../lib/i18n";
import { IconChevronLeftMedium } from "central-icons/IconChevronLeftMedium";
import type { ReactNode } from "react";

type StackHeaderProps = {
  title: string;
  onBack?: () => void;
  backLabel?: string;
  /** Right-aligned actions (icon buttons). */
  trailing?: ReactNode;
  /** Large iOS-style title on root screens; compact inline title when pushed. */
  large?: boolean;
};

export function StackHeader({ title, onBack, backLabel, trailing, large }: StackHeaderProps) {
  // A large title puts its actions on the title's own row, the way the
  // platform does. Rendering the compact row anyway left the buttons floating
  // in an otherwise empty 44 pt band above the title, with the title stranded
  // under a gap.
  if (large) {
    return (
      <header className="mobile-stack-header" data-large="true">
        {onBack ? (
          <div className="mobile-stack-header-row">
            <button type="button" className="mobile-back-button" onClick={onBack}>
              <IconChevronLeftMedium size={20} aria-hidden />
              <span>{backLabel ?? t("Back")}</span>
            </button>
          </div>
        ) : null}
        <div className="mobile-stack-header-large-row">
          <h1 className="mobile-stack-header-large-title">{title}</h1>
          {trailing ? <div className="mobile-stack-header-trailing">{trailing}</div> : null}
        </div>
      </header>
    );
  }

  return (
    <header className="mobile-stack-header">
      <div className="mobile-stack-header-row">
        {onBack ? (
          <button type="button" className="mobile-back-button" onClick={onBack}>
            <IconChevronLeftMedium size={20} aria-hidden />
            <span>{backLabel ?? t("Back")}</span>
          </button>
        ) : (
          <span className="mobile-stack-header-spacer" />
        )}
        <h1 className="mobile-stack-header-title">{title}</h1>
        <div className="mobile-stack-header-trailing">{trailing}</div>
      </div>
    </header>
  );
}
