import { AccountSettingsSection, AccountSetupOffer } from "../settings/AccountSettingsSection";
import { IconChevronLeftMedium } from "central-icons/IconChevronLeftMedium";
import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { t } from "../../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { CarpeDiemSettings } from "../settings/CarpeDiemSettings";
import { BrandGradientMark } from "../brand/Marks";
import { BrandPrimaryButton } from "../ui/BrandPrimaryButton";
import { CARPE_DIEM_DASHBOARD_URL, PRODUCT_NAME } from "../../lib/branding";
import { isMobilePlatform } from "../../lib/mobile";
import { carpeDiemRestartSidecar } from "../../lib/tauri";
import { useIssuanceStatus } from "../../lib/carpe-diem-issue";
import { NewAccountKeyOffer } from "./NewAccountKeyOffer";

/**
 * First-run gate: shown until a Carpe Diem API key is configured and the
 * sidecar is not in a failed state. Reuses the welcome-screen chrome so it
 * matches the app's existing sign-in flow. App.tsx dismisses it by re-deriving
 * `carpeDiemRequired` from the sidecar status event.
 *
 * Two reasons land here and they are not the same thing. Without a key, this is
 * the first screen of the product and it should read like one. With a key that
 * the engine then failed to start on, the same screen greeted a returning user
 * as a stranger and told them to get started -- which is both wrong and useless,
 * because getting started is exactly what just failed. The second case now says
 * what happened and what to do about it.
 *
 * Neither case invents a diagnosis. The app knows the engine did not come up;
 * it does not know why, and guessing at a cause the user would then chase is
 * worse than naming the two things actually worth checking.
 */
export function CarpeDiemGate({
  reason = "no-key",
}: {
  /** Why the gate is up: nothing configured yet, or configured and failed. */
  reason?: "no-key" | "failed";
}) {
  const mobile = isMobilePlatform();
  const failed = reason === "failed";
  // The engine can be asked to start again from here. It used to require a
  // trip to Settings, or a relaunch, for a failure that is often a network
  // blip at boot.
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const retry = () => {
    setRetrying(true);
    setRetryError(null);
    void carpeDiemRestartSidecar()
      .catch((error: unknown) => setRetryError(messageFromError(error)))
      .finally(() => setRetrying(false));
  };

  if (mobile && !failed) return <PhoneWelcome />;

  return (
    <div className="welcome-screen">
      <div className="welcome-card welcome-card-wide">
        <span className="welcome-mark welcome-mark-symbol" aria-hidden>
          <BrandGradientMark />
        </span>
        <h1 className="welcome-title">
          {failed
            ? t("{product} could not start", { product: PRODUCT_NAME })
            : t("Welcome to {product}", { product: PRODUCT_NAME })}
        </h1>
        <p className="welcome-subtitle">
          {failed
            ? t(
                "The local engine did not come up. Your notes are untouched. This is almost always the key or the connection: check the key below, then try again.",
              )
            : mobile
              ? t(
                  "{product} turns your meetings into notes, right on your phone. Create an account to connect your devices, or use your Carpe Diem key locally.",
                  { product: PRODUCT_NAME },
                )
              : t(
                  "{product} turns your meetings into notes on your computer. Create an account to connect your devices, or use your Carpe Diem key locally.",
                  { product: PRODUCT_NAME },
                )}
        </p>

        {failed ? null : <NewAccountKeyOffer />}
        <AccountSetupOffer />
        <CarpeDiemSettings compact />

        {failed ? (
          <div className="welcome-providers">
            <BrandPrimaryButton disabled={retrying} onClick={retry}>
              {retrying ? t("Starting…") : t("Try again")}
            </BrandPrimaryButton>
          </div>
        ) : null}

        {retryError ? (
          <p
            role="alert"
            className="settings-row-description settings-row-substatus"
            data-ok="false"
          >
            {retryError}
          </p>
        ) : null}

        <p className="welcome-terms">
          {failed ? (
            <>
              {t("Still stuck? Check that the key has credits in the")}{" "}
              <a href={CARPE_DIEM_DASHBOARD_URL} target="_blank" rel="noreferrer">
                {t("Carpe Diem dashboard")}
              </a>
              .
            </>
          ) : (
            <>
              {t("Need a key?")}{" "}
              <a href={CARPE_DIEM_DASHBOARD_URL} target="_blank" rel="noreferrer">
                {t("Create one and add credits")}
              </a>{" "}
              {t("in the Carpe Diem dashboard, then paste it above.")}
            </>
          )}
        </p>
      </div>
    </div>
  );
}

type WelcomePath = "choose" | "returning" | "key" | "new";

/**
 * The phone's first screen asks one question before it shows any control:
 * have you used Sub Rosa before? The two answers need different things. A
 * returning person signs in and opens their vault, and their key follows; a
 * new one pastes a key. Showing both at once, with the account panel folded
 * above the key form, left a returning person scrolling through settings they
 * did not need to find the one that let them in.
 *
 * When Carpe Diem can make a key from the account (ADR-0069), "I am new here"
 * means an email address and nothing else, and pasting a key becomes the
 * third answer for someone who already has one.
 */
function PhoneWelcome() {
  const [path, setPath] = useState<WelcomePath>("choose");
  const issuance = useIssuanceStatus();
  const canIssue = issuance?.keyIssuance === true;
  const root = useRef<HTMLDivElement>(null);
  // Each path is a new screen: it starts at its top, not wherever the last
  // one was scrolled to.
  useEffect(() => {
    const scroller = root.current?.closest(".mobile-gate-scroll");
    if (path && scroller) scroller.scrollTop = 0;
  }, [path]);

  const footer = (
    <p className="welcome-terms">
      {t("No key yet?")}{" "}
      <a href={CARPE_DIEM_DASHBOARD_URL} target="_blank" rel="noreferrer">
        {t("Create one and add credits")}
      </a>{" "}
      {t("in the Carpe Diem dashboard.")}
    </p>
  );

  if (path === "choose") {
    return (
      <div ref={root} className="welcome-screen welcome-screen-phone">
        <div className="welcome-card welcome-card-wide">
          <span className="welcome-mark welcome-mark-symbol" aria-hidden>
            <BrandGradientMark />
          </span>
          <h1 className="welcome-title">{t("Welcome to {product}", { product: PRODUCT_NAME })}</h1>
          <p className="welcome-subtitle">
            {t("{product} turns your meetings into notes, right on your phone.", {
              product: PRODUCT_NAME,
            })}
          </p>
          <div className="welcome-paths">
            <button type="button" className="welcome-path" onClick={() => setPath("returning")}>
              <span className="welcome-path-text">
                <strong>{t("I already use {product}", { product: PRODUCT_NAME })}</strong>
                <span>{t("Sign in to bring back your key and your notes.")}</span>
              </span>
              <IconChevronRightSmall size={16} aria-hidden />
            </button>
            {/* Which way "new" goes is decided when it is taken, not when the
                list is drawn: the answer from Carpe Diem may still be on its way. */}
            <button type="button" className="welcome-path" onClick={() => setPath("new")}>
              <span className="welcome-path-text">
                <strong>{t("I am new here")}</strong>
                <span>
                  {canIssue
                    ? t("Create your account with your email. Your key is made for you.")
                    : t("Paste your Carpe Diem key to start.")}
                </span>
              </span>
              <IconChevronRightSmall size={16} aria-hidden />
            </button>
            {canIssue ? (
              <button type="button" className="welcome-path" onClick={() => setPath("key")}>
                <span className="welcome-path-text">
                  <strong>{t("I have a Carpe Diem key")}</strong>
                  <span>{t("Paste it to start, without an account.")}</span>
                </span>
                <IconChevronRightSmall size={16} aria-hidden />
              </button>
            ) : null}
          </div>
          {canIssue ? null : footer}
        </div>
      </div>
    );
  }

  const back = (
    <button
      type="button"
      className="mobile-back-button welcome-back"
      onClick={() => setPath("choose")}
    >
      <IconChevronLeftMedium size={20} aria-hidden />
      <span>{t("Back")}</span>
    </button>
  );

  if (path === "new" && issuance === null) {
    return (
      <div ref={root} className="welcome-screen welcome-screen-phone">
        <div className="welcome-card welcome-card-wide">
          {back}
          <p role="status" className="welcome-subtitle">
            {t("Checking Carpe Diem…")}
          </p>
        </div>
      </div>
    );
  }

  if (path === "new" && canIssue) {
    return (
      <div ref={root} className="welcome-screen welcome-screen-phone">
        <div className="welcome-card welcome-card-wide">
          {back}
          <h1 className="welcome-title">{t("Create your account")}</h1>
          <p className="welcome-subtitle">
            {t(
              "Your email address is all it takes. Carpe Diem then makes a key for this phone, kept in its secure storage.",
            )}
          </p>
          <AccountSettingsSection mode="create" onUseKey={() => setPath("key")} />
        </div>
      </div>
    );
  }

  if (path === "returning") {
    return (
      <div ref={root} className="welcome-screen welcome-screen-phone">
        <div className="welcome-card welcome-card-wide">
          {back}
          <h1 className="welcome-title">{t("Welcome back")}</h1>
          <p className="welcome-subtitle">
            {canIssue
              ? t(
                  "Sign in, and your Carpe Diem key follows: from your vault if you keep one, or made for this phone from your account.",
                )
              : t(
                  "Sign in, then open your vault from a device that is already open or with your recovery key. Your Carpe Diem key comes back by itself.",
                )}
          </p>
          <AccountSettingsSection mode="restore" onUseKey={() => setPath("key")} />
        </div>
      </div>
    );
  }

  return (
    <div ref={root} className="welcome-screen welcome-screen-phone">
      <div className="welcome-card welcome-card-wide">
        {back}
        <h1 className="welcome-title">{t("Start with your key")}</h1>
        <p className="welcome-subtitle">
          {t(
            "Paste the key from your Carpe Diem dashboard. It stays in this phone's secure storage.",
          )}
        </p>
        <CarpeDiemSettings compact firstRun />
        {footer}
      </div>
    </div>
  );
}
