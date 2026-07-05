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
  return (
    <header className="mobile-stack-header" data-large={large ? "true" : undefined}>
      <div className="mobile-stack-header-row">
        {onBack ? (
          <button type="button" className="mobile-back-button" onClick={onBack}>
            <IconChevronLeftMedium size={20} aria-hidden />
            <span>{backLabel ?? "Back"}</span>
          </button>
        ) : (
          <span className="mobile-stack-header-spacer" />
        )}
        {!large ? <h1 className="mobile-stack-header-title">{title}</h1> : null}
        <div className="mobile-stack-header-trailing">{trailing}</div>
      </div>
      {large ? <h1 className="mobile-stack-header-large-title">{title}</h1> : null}
    </header>
  );
}
