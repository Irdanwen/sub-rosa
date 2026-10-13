import { useEffect, useState } from "react";

/**
 * The section being read, for a table of contents to mark: the last section
 * whose heading has passed the top band of the window. Read from an
 * IntersectionObserver, never from a scroll handler, and only in a browser
 * (the prerender marks nothing).
 */
export function useActiveSection(ids: readonly string[]): string | undefined {
  const [active, setActive] = useState<string>();
  const key = ids.join(" ");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const sections = key
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null);
    if (!sections.length) return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // The first section on screen, in document order.
        const first = sections.find((section) => visible.has(section.id));
        if (first) setActive(first.id);
      },
      // A band from under the sticky header to the upper half of the window.
      { rootMargin: "-90px 0px -55% 0px" },
    );
    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, [key]);
  return active;
}
