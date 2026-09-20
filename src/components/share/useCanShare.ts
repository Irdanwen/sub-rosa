import { useEffect, useState } from "react";
import { accountStatus, onAccountStatus } from "../../lib/account";

/**
 * Whether this device can make a link at all.
 *
 * A share needs somewhere to put the ciphertext, and that is the account
 * service. It does **not** need synchronisation to be on and it does not need
 * the vault open: the key that seals a share is generated for that share and
 * has nothing to do with the vault key. So you can show somebody one note
 * without having agreed to synchronise anything.
 */
export function useCanShare(): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => {
    const show = (status: { account: { email: string } | null }) => setCan(!!status.account);
    accountStatus()
      .then(show)
      .catch(() => undefined);
    return onAccountStatus(show);
  }, []);
  return can;
}
