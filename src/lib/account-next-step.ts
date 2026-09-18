/**
 * The one thing left to do, so the account panel can say it instead of leaving
 * a person to work it out from a page of controls.
 *
 * Connecting an app is four moves: sign in, have a vault, keep the recovery key
 * somewhere safe, then bring the Carpe Diem key down to this device. They are
 * ordered because each depends on the one before it: there is nothing to unlock
 * before a vault exists, and no key to restore before the vault is open.
 */
export type AccountStepId =
  | "sign-in"
  | "create-vault"
  | "open-vault"
  | "confirm-recovery"
  | "restore-key"
  | "done";

export type AccountStep = {
  id: AccountStepId;
  /** 1-based, for "Step 2 of 4". `done` keeps the last number rather than a fifth. */
  index: number;
  total: number;
};

export const ACCOUNT_STEP_TOTAL = 4;

export function accountNextStep(state: {
  signedIn: boolean;
  /** `null` while the service has not said yet: treated as "no vault". */
  vaultExists: boolean | null | undefined;
  vaultUnlocked: boolean;
  recoveryConfirmed: boolean;
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
  if (!state.hasLocalKey) return step("restore-key", 4);
  return step("done", ACCOUNT_STEP_TOTAL);
}
