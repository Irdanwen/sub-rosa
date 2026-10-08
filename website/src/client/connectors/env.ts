/**
 * The connectors' environment for one page: the account's objects, the
 * feature's sealed store, this browser's sealed secrets and the network. Tests
 * hand their own (`configureConnectors`).
 */
import type { FeatureHost } from "../feature";
import type { Fetch } from "./mcp";
import { appRedirectUri, type ConnectorEnv } from "./runtime";
import { indexedDbSecrets, type SecretBackend, Secrets } from "./secrets";

interface Options {
  fetch: Fetch;
  secrets: SecretBackend;
  redirectUri: () => string;
  /** Where the page goes to sign in. */
  navigate: (url: string) => void;
  /** The address the page was opened at, for a sign-in coming back. */
  location: () => string;
  /** Removes the sign-in's parameters from the address bar. */
  cleanLocation: () => void;
}

let options: Options = {
  fetch: (input, init) => fetch(input, init),
  secrets: indexedDbSecrets,
  redirectUri: () => appRedirectUri(),
  navigate: (url) => window.location.assign(url),
  location: () => window.location.href,
  cleanLocation: () => {
    const url = new URL(window.location.href);
    for (const name of ["code", "state", "error", "error_description", "iss"])
      url.searchParams.delete(name);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  },
};

export function configureConnectors(given: Partial<Options>) {
  options = { ...options, ...given };
}

export function connectorOptions(): Options {
  return options;
}

export function envFor(host: FeatureHost): ConnectorEnv {
  return {
    accountId: host.account.id,
    sync: host.sync,
    store: host.storeFor("connectors"),
    secrets: new Secrets(host.account.id, options.secrets),
    fetch: options.fetch,
    redirectUri: options.redirectUri(),
    deviceId: host.device.id,
  };
}
