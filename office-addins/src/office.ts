/**
 * The part of Office.js the task panes use, typed by hand: the library is
 * Microsoft's script on Microsoft's CDN (the page's one foreign script), so it
 * is a global, never a dependency of the build. Everything that touches a
 * document goes through the small adapters in each host's folder, which take
 * these globals as arguments and are what the tests replace.
 */

export type HostName = "Word" | "Excel" | "PowerPoint";

export interface AsyncResult<T> {
  status: "succeeded" | "failed";
  value: T;
  error?: { code: number; message: string };
}

/** A dialog the pane opened (`displayDialogAsync`). */
export interface OfficeDialog {
  addEventHandler(
    eventType: string,
    handler: (arg: { message?: string; origin?: string; error?: number }) => void,
  ): void;
  messageChild(message: string, options?: { targetOrigin: string }): void;
  close(): void;
}

export interface OfficeGlobal {
  onReady(): Promise<{ host: string | null; platform: string | null }>;
  context: {
    displayLanguage?: string;
    requirements?: { isSetSupported(name: string, minVersion?: string): boolean };
    ui: {
      displayDialogAsync(
        url: string,
        options: { height: number; width: number; promptBeforeOpen?: boolean },
        callback: (result: AsyncResult<OfficeDialog>) => void,
      ): void;
      messageParent(message: string, options?: { targetOrigin: string }): void;
      addHandlerAsync(
        eventType: string,
        handler: (arg: { message: string; origin?: string }) => void,
        callback?: (result: AsyncResult<void>) => void,
      ): void;
    };
  };
  EventType: {
    DialogMessageReceived: string;
    DialogEventReceived: string;
    DialogParentMessageReceived: string;
  };
}

/** Office, when the page runs inside it (or a test put a fake there). */
export function officeGlobal(): OfficeGlobal | null {
  return (globalThis as { Office?: OfficeGlobal }).Office ?? null;
}

/** Whether a requirement set is there. A host that cannot say is taken at
 * its word on the base sets and refused the newer ones. */
export function supports(office: OfficeGlobal | null, name: string, version: string): boolean {
  const requirements = office?.context.requirements;
  if (!requirements) return false;
  try {
    return requirements.isSetSupported(name, version);
  } catch {
    return false;
  }
}

/**
 * Waits for Office, at most `ms`: a page opened in a plain browser (to read
 * the sideloading help, or in a smoke test without the CDN) still renders and
 * says it is outside Office.
 */
export async function officeReady(
  office: OfficeGlobal | null = officeGlobal(),
  ms = 4000,
): Promise<HostName | null> {
  if (!office) return null;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
  const ready = office.onReady().then(
    (info) => info.host,
    () => null,
  );
  const host = await Promise.race([ready, timeout]);
  return host === "Word" || host === "Excel" || host === "PowerPoint" ? host : null;
}

/** The language a target of "translate into" defaults to, and the site's
 * copy follows: Office's display language. */
export function displayLanguage(office: OfficeGlobal | null = officeGlobal()): string {
  return office?.context.displayLanguage || navigator.language || "en-US";
}
