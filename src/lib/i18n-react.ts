import { useEffect, useState } from "react";
import { onLocaleChange } from "./i18n";

/**
 * A counter that ticks when the language changes. The root keys the shell
 * on it, so a switch re-renders every `t()` in one pass; a component that
 * caches a translated sentence in state can subscribe the same way.
 */
export function useLocaleVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => onLocaleChange(() => setVersion((value) => value + 1)), []);
  return version;
}
