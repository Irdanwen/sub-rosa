/**
 * The PowerPoint calls the pane makes (PowerPointApi 1.2, and 1.5 to place
 * the slides after the one selected), behind an adapter the tests replace.
 */

export interface PowerPointContext {
  presentation: {
    insertSlidesFromBase64(
      base64: string,
      options?: {
        formatting?: "KeepSourceFormatting" | "UseDestinationTheme";
        targetSlideId?: string;
      },
    ): void;
    getSelectedSlides(): { items: { id: string }[]; load(properties: string): void };
  };
  sync(): Promise<void>;
}
export interface PowerPointApi {
  run<T>(batch: (context: PowerPointContext) => Promise<T>): Promise<T>;
}

export function powerPointGlobal(): PowerPointApi | null {
  return (globalThis as { PowerPoint?: PowerPointApi }).PowerPoint ?? null;
}

/** Standard base64, which `insertSlidesFromBase64` reads. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function powerPointHost(powerPoint: PowerPointApi, canPlace: boolean) {
  return {
    /** Adds the deck's slides in the presentation's own theme, after the
     * selected slide when Office can say which one that is. */
    async insertSlides(pptx: Uint8Array): Promise<void> {
      await powerPoint.run(async (context) => {
        let targetSlideId: string | undefined;
        if (canPlace) {
          const selected = context.presentation.getSelectedSlides();
          selected.load("items/id");
          await context.sync();
          targetSlideId = selected.items.at(-1)?.id;
        }
        context.presentation.insertSlidesFromBase64(toBase64(pptx), {
          formatting: "UseDestinationTheme",
          ...(targetSlideId ? { targetSlideId } : {}),
        });
        await context.sync();
      });
    },
  };
}
export type PowerPointHost = ReturnType<typeof powerPointHost>;
