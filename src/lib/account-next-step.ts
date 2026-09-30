/**
 * The one thing left to do, so the account panel can say it instead of leaving
 * a person to work it out from a page of controls.
 *
 * Connecting an app is five moves: sign in, open or create the vault, confirm
 * recovery when creating it, bring the Carpe Diem key to a device that needs
 * it, then consent to sync. Existing devices skip completed moves.
 *
 * When Carpe Diem can create a key from the account (ADR-0069), the key moves
 * up to second: it needs no vault, and a device without one cannot run at all.
 */
export type AccountStepId =
  | "sign-in"
  | "create-vault"
  | "open-vault"
  | "confirm-recovery"
  | "enable-sync"
  | "restore-key"
  | "issue-key"
  | "done";

export type AccountStep = {
  id: AccountStepId;
  /** 1-based, for "Step 2 of 5". `done` keeps the last number. */
  index: number;
  total: number;
};

export const ACCOUNT_STEP_TOTAL = 5;

export function accountNextStep(state: {
  signedIn: boolean;
  /** `null` while the service has not said yet: treated as "no vault". */
  vaultExists: boolean | null | undefined;
  vaultUnlocked: boolean;
  recoveryConfirmed: boolean;
  syncEnabled: boolean;
  /** Whether this device already holds a Carpe Diem key of its own. */
  hasLocalKey: boolean;
  /** Carpe Diem can create this device's key from the account. */
  keyIssuance?: boolean;
}): AccountStep {
  const step = (id: AccountStepId, index: number): AccountStep => ({
    id,
    index,
    total: ACCOUNT_STEP_TOTAL,
  });
  if (!state.signedIn) return step("sign-in", 1);
  if (state.keyIssuance) {
    if (!state.hasLocalKey) return step("issue-key", 2);
    if (state.vaultExists !== true) return step("create-vault", 3);
    if (!state.vaultUnlocked) return step("open-vault", 3);
    if (!state.recoveryConfirmed) return step("confirm-recovery", 4);
    if (!state.syncEnabled) return step("enable-sync", 5);
    return step("done", ACCOUNT_STEP_TOTAL);
  }
  if (state.vaultExists !== true) return step("create-vault", 2);
  if (!state.vaultUnlocked) return step("open-vault", 2);
  if (!state.recoveryConfirmed) return step("confirm-recovery", 3);
  // The key comes before sync consent: restoring it decrypts one settings
  // object and uploads nothing, and a device without it cannot run at all.
  // Asking for sync first left a new phone at the key gate with the way out
  // below a consent form it had no reason to fill in.
  if (!state.hasLocalKey) return step("restore-key", 4);
  if (!state.syncEnabled) return step("enable-sync", 5);
  return step("done", ACCOUNT_STEP_TOTAL);
}
