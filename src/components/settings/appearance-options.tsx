/**
 * The choices the Appearance rows offer: the theme and the language, each
 * with its glyph. Apart from the settings view so the view stays under its
 * size ceiling, and because a list of options is data, not behaviour.
 */
import { IconMoonStar } from "central-icons/IconMoonStar";
import { IconSun } from "central-icons/IconSun";
import { IconTelevision } from "central-icons/IconTelevision";
import type { ReactNode } from "react";
import { type LocaleChoice, t } from "../../lib/i18n";
import type { ThemePreference } from "../../lib/theme";

export const UI_LANGUAGE_OPTIONS: readonly {
  value: LocaleChoice;
  label: ReactNode;
  ariaLabel: string;
}[] = [
  { value: "system", label: t("System"), ariaLabel: t("Follow the system language") },
  { value: "en", label: t("English"), ariaLabel: "English" },
  { value: "fr", label: t("Français"), ariaLabel: "Français" },
];

export const THEME_OPTIONS: readonly {
  value: ThemePreference;
  label: ReactNode;
  ariaLabel: string;
}[] = [
  {
    value: "system",
    label: (
      <>
        <IconTelevision size={14} />
        {t("System")}
      </>
    ),
    ariaLabel: "Match system theme",
  },
  {
    value: "light",
    label: (
      <>
        <IconSun size={14} />
        {t("Light")}
      </>
    ),
    ariaLabel: "Use light theme",
  },
  {
    value: "dark",
    label: (
      <>
        <IconMoonStar size={14} />
        {t("Dark")}
      </>
    ),
    ariaLabel: "Use dark theme",
  },
];
