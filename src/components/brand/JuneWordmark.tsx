import { useId } from "react";

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
      aria-label="Sub Rosa"
    >
      {/* Squircle mark — gradient derives from the selected accent. */}
      <rect width="18" height="18" rx="4" fill={`url(#${gradientId})`} />
      <g fill="white">
        <path d="M14.0417 8.53571C14.2948 8.53571 14.5 8.74358 14.5 9V10.3929C14.5 10.6493 14.2948 10.8571 14.0417 10.8571H13.0462C12.9247 10.8572 12.8081 10.9061 12.7222 10.9932L12.3426 11.3777C12.2567 11.4647 12.2084 11.5828 12.2083 11.7059V12.7143C12.2083 12.9707 12.0031 13.1786 11.75 13.1786H6.62956C6.50802 13.1786 6.39144 13.2275 6.3055 13.3146L5.92594 13.6991C5.84001 13.7861 5.79169 13.9042 5.79167 14.0273V15.0357C5.79167 15.2921 5.58646 15.5 5.33333 15.5H3.95833C3.7052 15.5 3.5 15.2921 3.5 15.0357V13.6429C3.5 13.3864 3.7052 13.1786 3.95833 13.1786H4.95378C5.07531 13.1786 5.19189 13.1296 5.27783 13.0426L5.65739 12.6581C5.74333 12.571 5.79165 12.4529 5.79167 12.3298V11.3214C5.79167 11.065 5.99687 10.8571 6.25 10.8571H11.3704C11.492 10.8571 11.6086 10.8082 11.6945 10.7211L12.0741 10.3366C12.16 10.2496 12.2083 10.1315 12.2083 10.0084V9C12.2083 8.74358 12.4135 8.53571 12.6667 8.53571H14.0417Z" />
        <path d="M14.0417 2.5C14.2948 2.5 14.5 2.70787 14.5 2.96429V4.35714C14.5 4.61356 14.2948 4.82143 14.0417 4.82143H13.0462C12.9247 4.82145 12.8081 4.8704 12.7222 4.95745L12.3426 5.34194C12.2567 5.42899 12.2084 5.54709 12.2083 5.6702V6.67857C12.2083 6.93499 12.0031 7.14286 11.75 7.14286H6.62956C6.50802 7.14288 6.39144 7.19182 6.3055 7.27888L5.92594 7.66336C5.84001 7.75042 5.79169 7.86852 5.79167 7.99163V9C5.79167 9.25642 5.58646 9.46429 5.33333 9.46429H3.95833C3.7052 9.46429 3.5 9.25642 3.5 9V7.60714C3.5 7.35072 3.7052 7.14286 3.95833 7.14286H4.95378C5.07531 7.14284 5.19189 7.09389 5.27783 7.00684L5.65739 6.62235C5.74333 6.5353 5.79165 6.4172 5.79167 6.29408V5.28571C5.79167 5.0293 5.99687 4.82143 6.25 4.82143H11.3704C11.492 4.82141 11.6086 4.77246 11.6945 4.68541L12.0741 4.30092C12.16 4.21387 12.2083 4.09577 12.2083 3.97266V2.96429C12.2083 2.70787 12.4135 2.5 12.6667 2.5H14.0417Z" />
      </g>
      {/* "Sub Rosa" wordmark in the brand serif; follows the text color. */}
      <text
        x="24"
        y="13.6"
        fill="currentColor"
        fontSize="14"
        style={{ fontFamily: "var(--font-serif)", fontWeight: 500 }}
      >
        Sub Rosa
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
