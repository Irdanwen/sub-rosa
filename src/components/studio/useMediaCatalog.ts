import { useCallback, useEffect, useState } from "react";
import { fetchMediaCatalog } from "../../lib/studio/catalog";
import type { MediaCatalog } from "../../lib/studio/types";

/** Loads the merged media catalog once per mount (the lib caches it). */
export function useMediaCatalog() {
  const [catalog, setCatalog] = useState<MediaCatalog | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(undefined);
    try {
      setCatalog(await fetchMediaCatalog(force));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Couldn't load the model catalog.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { catalog, error, loading, retry: () => void load(true) };
}
