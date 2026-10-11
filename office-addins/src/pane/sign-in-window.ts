/**
 * Opens the sign-in window (`/office/session.html`, on the pane's own office
 * origin) with Office's dialog API and, once it says who is signed in, routes
 * the account service's calls through it and its courier frame
 * (`office-courier.ts`, ADR-0102 and its addendum). Closing the window, by the
 * person or by `close`, puts back the pane's default transport, which reaches
 * nothing: a pane never calls the account service itself.
 */
import {
  type Account,
  type ApiTransport,
  setAccountScope,
  setApiTransport,
} from "../../../website/src/lib/api";
import { courierTransport, parseMessage } from "../../../website/src/lib/office-courier";
import { type OfficeDialog, type OfficeGlobal, supports } from "../office";

export const SIGN_IN_PATH = "/office/session.html";

/**
 * The pane's transport while no sign-in window is open. The account's cookie
 * never reaches the office origin and that origin serves no `/api/`, so a
 * call there could only fail, or worse, reach whatever answered: the pane
 * answers itself that there is no session, without a request.
 */
export const noSession: ApiTransport = async () =>
  new Response(JSON.stringify({ error: { code: "unauthorized" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

export interface SignInWindow {
  account: Account;
  close(): void;
}

export class SignInWindowError extends Error {
  constructor(public code: "unsupported" | "blocked" | "closed") {
    super(code);
  }
}

/**
 * Resolves when the window has a signed-in account; rejects if it cannot open
 * or is closed first. `onClosed` runs whenever the window goes away later.
 */
export function openSignInWindow(
  office: OfficeGlobal,
  options: { fresh?: boolean; onClosed?: () => void } = {},
  origin = location.origin,
): Promise<SignInWindow> {
  // Messages to the window (`messageChild`) need DialogApi 1.2.
  if (!supports(office, "DialogApi", "1.2"))
    return Promise.reject(new SignInWindowError("unsupported"));
  const url = `${origin}${SIGN_IN_PATH}${options.fresh ? "?fresh=1" : ""}`;
  return new Promise<SignInWindow>((resolve, reject) => {
    office.context.ui.displayDialogAsync(url, { height: 70, width: 35 }, (result) => {
      if (result.status !== "succeeded") {
        reject(new SignInWindowError("blocked"));
        return;
      }
      const dialog: OfficeDialog = result.value;
      const courier = courierTransport((message) =>
        dialog.messageChild(message, { targetOrigin: origin }),
      );
      let settled = false;
      let open = true;
      const shut = () => {
        if (!open) return;
        open = false;
        courier.closed();
        setApiTransport(noSession);
      };
      dialog.addEventHandler(office.EventType.DialogMessageReceived, (arg) => {
        // Only the account origin's own page speaks for the session.
        if (arg.origin && arg.origin !== origin) return;
        const message = parseMessage(arg.message);
        if (!message) return;
        if (message.type === "response") courier.receive(message);
        else if (message.type === "ready" && !settled) {
          settled = true;
          setApiTransport(courier.transport);
          setAccountScope(message.account.id);
          resolve({
            account: { ...message.account, created_at: "" },
            close: () => {
              shut();
              try {
                dialog.close();
              } catch {
                // Already closed by the person.
              }
            },
          });
        }
      });
      dialog.addEventHandler(office.EventType.DialogEventReceived, () => {
        shut();
        if (!settled) {
          settled = true;
          reject(new SignInWindowError("closed"));
        }
        options.onClosed?.();
      });
    });
  });
}
