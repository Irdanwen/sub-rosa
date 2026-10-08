/**
 * Protected mode held by this browser: on or off, the PIN's hash and the
 * switches, sealed in the feature's own store. Like the app's settings file
 * it stays here (ADR-0084: a policy one device pushed to another would need
 * a trust model the product does not have), so each browser is set apart.
 */
import type { FeatureStore } from "../feature";
import { PIN_ITERATIONS, type PinHash, hashPin, pinMatches, Throttle, validPin } from "./pin";
import { NO_RESTRICTIONS, type Restrictions, refusal, validWindow } from "./rules";

export interface ProtectedSettings {
  enabled: boolean;
  pin?: PinHash;
  /** Kept, out of force, while protected mode is off. */
  restrictions: Restrictions;
}
export const OFF: ProtectedSettings = { enabled: false, restrictions: NO_RESTRICTIONS };

export type Outcome = { ok: true } | { ok: false; reason: string };

const KEY = "settings";
/** One throttle for the page, like the app's one per process. */
const pageThrottle = new Throttle();

export class ProtectedMode {
  constructor(
    private readonly store: FeatureStore,
    private readonly throttle: Throttle = pageThrottle,
    private readonly iterations = PIN_ITERATIONS,
  ) {}

  async load(): Promise<ProtectedSettings> {
    const saved = await this.store.get<ProtectedSettings>(KEY);
    if (!saved) return OFF;
    return {
      enabled: saved.enabled === true && !!saved.pin,
      pin: saved.pin,
      restrictions: { ...NO_RESTRICTIONS, ...(saved.restrictions ?? {}) },
    };
  }

  private async check(pin: string, stored: PinHash | undefined): Promise<Outcome> {
    if (!this.throttle.allowed()) return { ok: false, reason: refusal.locked() };
    const ok = await pinMatches(pin, stored);
    this.throttle.record(ok);
    return ok ? { ok: true } : { ok: false, reason: refusal.wrongPin() };
  }

  async turnOn(pin: string): Promise<Outcome> {
    if (!validPin(pin)) return { ok: false, reason: refusal.pinFormat() };
    const current = await this.load();
    if (current.enabled) return { ok: true };
    await this.store.put(KEY, {
      enabled: true,
      pin: await hashPin(pin, this.iterations),
      restrictions: current.restrictions,
    } satisfies ProtectedSettings);
    return { ok: true };
  }

  /** Takes the PIN and forgets it; the switches are kept for next time. */
  async turnOff(pin: string): Promise<Outcome> {
    const current = await this.load();
    if (!current.enabled) return { ok: true };
    const checked = await this.check(pin, current.pin);
    if (!checked.ok) return checked;
    await this.store.put(KEY, {
      enabled: false,
      restrictions: current.restrictions,
    } satisfies ProtectedSettings);
    return { ok: true };
  }

  async setRestrictions(pin: string, restrictions: Restrictions): Promise<Outcome> {
    if (!validWindow(restrictions.quietHours))
      return { ok: false, reason: refusal.quietHoursInvalid() };
    const current = await this.load();
    if (!current.enabled) return { ok: false, reason: refusal.wrongPin() };
    const checked = await this.check(pin, current.pin);
    if (!checked.ok) return checked;
    await this.store.put(KEY, { ...current, restrictions } satisfies ProtectedSettings);
    return { ok: true };
  }
}
