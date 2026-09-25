/**
 * The one thing left to do, so the account panel can say it instead of leaving
 * a person to work it out from a page of controls.
 *
 * Connecting an app is five moves: sign in, open or create the vault, confirm
 * recovery when creating it, consent to sync, then bring the Carpe Diem key to
 * a device that needs it. Existing devices skip completed moves.
 */
export type AccountStepId =
  | "sign-in"
  | "create-vault"
  | "open-vault"
  | "confirm-recovery"
  | "enable-sync"
  | "restore-key"
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
}): AccountStep {
  const step = (id: AccountStepId, index: number): AccountStep => ({
    id,
    index,
    total: ACCOUNT_STEP_TOTAL,
  });
  if (!state.signedIn) return step("sign-in", 1);
  if (state.vaultExists !== true) return step("create-vault", 2);
  if (!state.vaultUnlocked) return step("open-vault", 2);
  if (!state.recoveryConfirmed) return step("confirm-recovery", 3);
  if (!state.syncEnabled) return step("enable-sync", 4);
  if (!state.hasLocalKey) return step("restore-key", 5);
  return step("done", ACCOUNT_STEP_TOTAL);
}
