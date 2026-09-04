import { t } from "../../lib/i18n";
import { useId } from "react";
import { ROSE_MARK_PATH } from "./roseMark";

/**
 * The Sub Rosa wordmark: the squircle mark + "Sub Rosa" in the brand serif,
 * inlined so it follows the live theme. The lettering paints in `currentColor`
 * (set by the caller per light/dark) and the mark's squircle gradient derives
 * from --brand, so picking a new accent recolors the logo everywhere it renders
 * (sidebar header, etc.). Scales to the caller's height with width:auto.
 *
 * (Component name kept as `JuneWordmark` — a technical identifier imported in
 * several places — while the rendered brand is Sub Rosa.)
 */
export function JuneWordmark({ className }: { className?: string }) {
  const gradientId = `subrosa-wordmark-${useId().replace(/:/g, "")}`;
  return (
    <svg
      className={className}
      width="100"
      height="18"
      viewBox="0 0 100 18"
      fill="none"
      role="img"
      aria-label={t("Sub Rosa")}
    >
      {/* Squircle mark — gradient derives from the selected accent; the rose
          glyph fills ~62% of the tile, matching the app icon's proportions. */}
      <rect width="18" height="18" rx="4" fill={`url(#${gradientId})`} />
      <path fill="white" transform="translate(3.45 3.45) scale(0.4625)" d={ROSE_MARK_PATH} />
      {/* "Sub Rosa" wordmark in the brand serif; follows the text color. */}
      <text
        x="24"
        y="13.6"
        fill="currentColor"
        fontSize="14"
        style={{ fontFamily: "var(--font-serif)", fontWeight: 500 }}
      >
        {t("Sub Rosa")}
      </text>
      <defs>
        <linearGradient id={gradientId} x1="9" y1="0" x2="9" y2="18" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: "color-mix(in oklch, var(--brand) 55%, white)" }} />
          <stop offset="1" style={{ stopColor: "var(--brand)" }} />
        </linearGradient>
      </defs>
    </svg>
  );
}
