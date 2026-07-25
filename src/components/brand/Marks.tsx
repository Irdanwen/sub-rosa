import { useId } from "react";
import { ROSE_MARK_PATH, ROSE_MARK_VIEWBOX } from "./roseMark";

// The Sub Rosa rose glyph, in the two sizes the shell uses: a small solid mark
// for chrome (sidebar, menus) and a larger gradient one for full-screen cards
// (gates, onboarding, startup failures).
//
// These lived in AccountGate.tsx until OS Accounts was removed. They are brand
// chrome, not account UI, so they outlived that file.

/** Small solid mark, drawn in currentColor. */
export function BrandMark() {
  return (
    <svg width="26" height="26" viewBox={ROSE_MARK_VIEWBOX} fill="currentColor" aria-hidden>
      <path d={ROSE_MARK_PATH} />
    </svg>
  );
}

/** Larger mark with the brand gradient, for full-screen cards. */
export function BrandGradientMark() {
  // useId returns a value containing ":", which is not valid inside an SVG
  // fragment reference.
  const gradientId = `brand-gradient-${useId().replace(/:/g, "")}`;

  return (
    <svg width="42" height="42" viewBox={ROSE_MARK_VIEWBOX} fill="none" aria-hidden>
      <defs>
        <linearGradient
          id={gradientId}
          x1="12"
          y1="0"
          x2="12"
          y2="24"
          gradientUnits="userSpaceOnUse"
        >
          <stop style={{ stopColor: "color-mix(in oklch, var(--brand) 55%, white)" }} />
          <stop offset="1" style={{ stopColor: "var(--brand)" }} />
        </linearGradient>
      </defs>
      <path fill={`url(#${gradientId})`} d={ROSE_MARK_PATH} />
    </svg>
  );
}
