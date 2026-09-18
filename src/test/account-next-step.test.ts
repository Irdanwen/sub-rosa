import { describe, expect, it } from "vitest";
import { ACCOUNT_STEP_TOTAL, accountNextStep } from "../lib/account-next-step";

const connected = {
  signedIn: true,
  vaultExists: true,
  vaultUnlocked: true,
  recoveryConfirmed: true,
  hasLocalKey: true,
};

describe("the next account step", () => {
  it("asks to sign in before anything else", () => {
    expect(accountNextStep({ ...connected, signedIn: false }).id).toBe("sign-in");
  });

  it("asks for a vault once signed in, and is not fooled by an unknown one", () => {
    for (const vaultExists of [false, null, undefined]) {
      expect(accountNextStep({ ...connected, vaultExists }).id).toBe("create-vault");
    }
  });

  it("asks to open an existing vault before the recovery key is judged", () => {
    const step = accountNextStep({
      ...connected,
      vaultUnlocked: false,
      recoveryConfirmed: false,
    });
    expect(step.id).toBe("open-vault");
  });

  it("asks to confirm the recovery key once the vault is open", () => {
    expect(accountNextStep({ ...connected, recoveryConfirmed: false }).id).toBe("confirm-recovery");
  });

  it("asks for the key last, and only when this device has none", () => {
    expect(accountNextStep({ ...connected, hasLocalKey: false }).id).toBe("restore-key");
    expect(accountNextStep(connected).id).toBe("done");
  });

  it("numbers the steps in order and never past the total", () => {
    const order: string[] = [];
    let state = { ...connected, signedIn: false, vaultExists: false as boolean | null };
    const seen: number[] = [];
    for (const relax of [
      () => {
        state = { ...state, signedIn: true };
      },
      () => {
        state = { ...state, vaultExists: true, vaultUnlocked: false };
      },
      () => {
        state = { ...state, vaultUnlocked: true, recoveryConfirmed: false };
      },
      () => {
        state = { ...state, recoveryConfirmed: true, hasLocalKey: false };
      },
    ]) {
      const step = accountNextStep(state);
      order.push(step.id);
      seen.push(step.index);
      relax();
    }
    expect(order).toEqual(["sign-in", "create-vault", "open-vault", "confirm-recovery"]);
    expect(seen).toEqual([1, 2, 2, 3]);
    expect(seen.every((n) => n <= ACCOUNT_STEP_TOTAL)).toBe(true);
  });
});
