import { intlLocale, t } from "../../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { IconCreditCard1 } from "central-icons/IconCreditCard1";
import { IconPeople } from "central-icons/IconPeople";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
import { CategoryIcon } from "../agent/composer/CategoryIcon";
import type { ReportCategory } from "../agent/composer/reportCategory";
import { useCarpeDiemCredits } from "../../lib/carpe-diem-credits";
import type { CarpeDiemCreditsDto } from "../../lib/tauri";
import { accountStatus } from "../../lib/account";

// The user's name is the settings entry point: clicking it opens a small
// popover whose actions open the settings page or sign out.
// The report shortcuts in the account menu: the same set as the composer's
// "+" popover, minus attaching a file. Action-phrased to read as menu verbs.
const REPORT_MENU_ITEMS: { category: ReportCategory; label: string }[] = [
  { category: "bug", label: t("Report a bug") },
  { category: "feedback", label: t("Send feedback") },
  { category: "feature", label: t("Request a feature") },
];

export function SidebarIdentity({
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onOpenSettings,
  onOpenAccount,
  onReportIssue,
}: {
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onOpenSettings: () => void;
  onOpenAccount?: () => void;
  onReportIssue?: (category: ReportCategory) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // Who you are signed in as belongs in the window, not three clicks into
  // Settings. The Carpe Diem balance keeps its place, underneath.
  const credits = useCarpeDiemCredits();
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    accountStatus()
      .then((status) => setEmail(status.account?.email ?? null))
      .catch(() => undefined);
  }, []);
  const balance = credits ? creditsLabel(credits) : null;
  const label = email ?? t("Sign in");

  useEffect(() => {
    if (!menuOpen) return;
    function onPointer(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) onCloseMenu();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCloseMenu();
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, onCloseMenu]);

  return (
    <div className="sidebar-identity-wrap" ref={wrapRef}>
      <button
        type="button"
        className="sidebar-nav-item sidebar-identity"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t("{label}, app menu", { label: email ?? t("Sign in") })}
        onClick={onToggleMenu}
      >
        <span className="sidebar-nav-icon">
          {email ? <IconPeople size={18} /> : <IconCreditCard1 size={18} />}
        </span>
        <span className="sidebar-identity-lines">
          <span className="sidebar-nav-label">{label}</span>
          {balance ? <span className="sidebar-identity-sub">{balance}</span> : null}
        </span>
      </button>
      {menuOpen ? (
        <div className="sidebar-identity-menu" role="menu">
          {onOpenAccount ? (
            <button type="button" role="menuitem" onClick={onOpenAccount}>
              <IconPeople size={14} />
              {email ? t("Account and sync") : t("Sign in or create an account")}
            </button>
          ) : null}
          <button type="button" role="menuitem" onClick={onOpenSettings}>
            <IconSettingsGear4 size={14} />
            {t("Settings")}
          </button>
          {onReportIssue
            ? REPORT_MENU_ITEMS.map((item) => (
                <button
                  key={item.category}
                  type="button"
                  role="menuitem"
                  onClick={() => onReportIssue(item.category)}
                >
                  <span className="sidebar-report-icon" data-category={item.category}>
                    <CategoryIcon category={item.category} size={14} />
                  </span>
                  {item.label}
                </button>
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}

// "1,234 credits · ×0.42" — the spendable balance plus the current Carpe Diem
// price factor (the fraction of the upstream rate billed today). The factor is
// omitted when the public pricing endpoint didn't answer.
function creditsLabel(credits: CarpeDiemCreditsDto) {
  const amount = Math.floor(credits.availableCredits).toLocaleString(intlLocale());
  // The balance follows the active rail; flag a prepaid balance so it isn't
  // mistaken for the (possibly larger, unused) credits pool.
  const railHint = credits.rail === "prepaid" ? " · prepaid" : "";
  const factor = credits.priceMultiplier != null ? ` · ×${credits.priceMultiplier.toFixed(2)}` : "";
  return `${amount} credits${railHint}${factor}`;
}
