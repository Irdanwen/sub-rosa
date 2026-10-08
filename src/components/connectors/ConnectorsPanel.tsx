import "../../styles/connectors.css";
import { IconConnectors1 } from "central-icons/IconConnectors1";
import { useState } from "react";
import {
  type CatalogServer,
  type Connector,
  type ConnectorCatalog,
  type DeviceSignIn,
  type SignInResult,
  connectorAdd,
  connectorRemove,
  connectorSetEnabled,
  connectorSetToken,
  connectorSignIn,
  connectorSignOut,
  readDeveloperMode,
  writeDeveloperMode,
} from "../../lib/connectors";
import { friendlyErrorMessage } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { openExternalUrl } from "../../lib/tauri";
import { Switch } from "../ui/Switch";
import { ToolRules, connectorStateLabel } from "./ToolRules";

type Props = {
  connectors: Connector[] | null;
  catalog: ConnectorCatalog | null;
  refresh: () => void;
  /** Called once a connector is removed, for what a shell keeps beside it. */
  onRemoved?: (connector: Connector) => Promise<unknown>;
};

/**
 * Connectors, the same on both shells: the ones added, with their sign-in
 * and their tools' rules; the one-tap catalog; and, in developer mode, any
 * server by its address.
 */
export function ConnectorsPanel({ connectors, catalog, refresh, onRemoved }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [device, setDevice] = useState<{ connectorId: string; sign: DeviceSignIn } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [developer, setDeveloper] = useState(readDeveloperMode);

  const run = async (key: string, work: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(key);
    setNotice(null);
    try {
      await work();
      if (done) setNotice({ text: done, error: false });
    } catch (cause) {
      setNotice({
        text: friendlyErrorMessage(cause, t("That could not be done just now.")),
        error: true,
      });
    } finally {
      setBusy(null);
      refresh();
    }
  };

  /** What a sign-in asks of the person next: a code to type, or the
   * browser it opened. */
  const followSignIn = (connectorId: string, result: SignInResult) => {
    if (result.device) {
      setDevice({ connectorId, sign: result.device });
      return;
    }
    if (!result.connected) {
      setNotice({
        text: t("Finish signing in in your browser. Sub Rosa comes back by itself."),
        error: false,
      });
    }
  };

  const signIn = (connector: Connector) =>
    run(connector.id, async () => followSignIn(connector.id, await connectorSignIn(connector.id)));

  /** Adds a catalog entry or a built-in provider and signs in to it, the same
   * on every shell: the computer's agent reaches it through the app. */
  const connect = (catalogId: string) =>
    run(catalogId, async () => {
      const added = await connectorAdd({ catalogId });
      followSignIn(added.id, await connectorSignIn(added.id));
    });

  const remove = (connector: Connector) =>
    run(
      connector.id,
      async () => {
        await connectorRemove(connector.id);
        await onRemoved?.(connector);
      },
      t("{name} removed.", { name: connector.name }),
    );

  const added = new Set((connectors ?? []).map((connector) => connector.id));

  return (
    <div className="connectors-form">
      {notice ? (
        <p
          className="connectors-row-meta"
          data-tone={notice.error ? "error" : undefined}
          role={notice.error ? "alert" : "status"}
        >
          {notice.text}
        </p>
      ) : null}

      {device && !connectors?.some((item) => item.id === device.connectorId && item.signedIn) ? (
        <DeviceCode sign={device.sign} onDismiss={() => setDevice(null)} />
      ) : null}

      <h3 className="settings-row-title">{t("Your connectors")}</h3>
      {connectors && connectors.length === 0 ? (
        <p className="connectors-row-meta">{t("Nothing connected yet. Pick a service below.")}</p>
      ) : null}
      <ul className="connectors-list">
        {(connectors ?? []).map((connector) => {
          const state = connectorStateLabel(connector);
          const expanded = open === connector.id;
          return (
            <li key={connector.id} className="connectors-row" data-expanded={expanded}>
              <span className="chat-block-row-icon" aria-hidden>
                <IconConnectors1 size={16} />
              </span>
              <span className="connectors-row-body">
                <span className="connectors-row-title">{connector.name}</span>
                <span className="connectors-row-meta" data-tone={state.error ? "error" : undefined}>
                  {state.text}
                </span>
                <span className="connector-card-actions">
                  {!connector.signedIn || connector.status === "needs_sign_in" ? (
                    connector.auth === "token" ? (
                      <TokenForm
                        connector={connector}
                        onSaved={refresh}
                        onError={(text) => setNotice({ text, error: true })}
                      />
                    ) : (
                      <button
                        type="button"
                        className="proposal-do"
                        disabled={busy !== null}
                        onClick={() => void signIn(connector)}
                      >
                        {t("Sign in")}
                      </button>
                    )
                  ) : (
                    <button
                      type="button"
                      className="proposal-do"
                      disabled={busy !== null}
                      onClick={() => void run(connector.id, () => connectorSignOut(connector.id))}
                    >
                      {t("Sign out on this device")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="proposal-do"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : connector.id)}
                  >
                    {expanded ? t("Hide tools") : t("Tools")}
                  </button>
                  <button
                    type="button"
                    className="proposal-do"
                    disabled={busy !== null}
                    onClick={() => void remove(connector)}
                  >
                    {t("Remove")}
                  </button>
                </span>
                {expanded ? <ToolRules connector={connector} onChanged={refresh} /> : null}
              </span>
              <Switch
                checked={connector.enabled}
                aria-label={t("Use {name}", { name: connector.name })}
                onCheckedChange={(next) =>
                  void run(connector.id, () => connectorSetEnabled(connector.id, next))
                }
              />
            </li>
          );
        })}
      </ul>

      <h3 className="settings-row-title">{t("Add a connector")}</h3>
      <p className="connectors-row-meta">
        {t(
          "Each one signs in on this device. Its access stays in this device's keychain and never syncs; what you connected and your rules for its tools do.",
        )}
      </p>
      <ul className="connectors-list">
        {(catalog?.builtins ?? []).map((builtin) => (
          <li key={builtin.id} className="connectors-row">
            <span className="connectors-row-body">
              <span className="connectors-row-title">{builtin.name}</span>
              <span className="connectors-row-meta">{builtinDescription(builtin.id)}</span>
              {builtin.gated.map((gate) => (
                <span key={gate.id} className="connectors-row-meta">
                  {t("{name}: requires verification by Google before Sub Rosa may read it.", {
                    name: gate.name,
                  })}
                </span>
              ))}
            </span>
            {builtin.available ? (
              <button
                type="button"
                className="proposal-do"
                disabled={busy !== null || added.has(builtin.id)}
                onClick={() => void connect(builtin.id)}
              >
                {added.has(builtin.id) ? t("Added") : t("Connect")}
              </button>
            ) : (
              <span className="connectors-row-meta">{t("Not available in this build")}</span>
            )}
          </li>
        ))}
        {(catalog?.servers ?? []).map((server) => (
          <li key={server.id} className="connectors-row">
            <span className="connectors-row-body">
              <span className="connectors-row-title">{server.name}</span>
              <span className="connectors-row-meta">{catalogDescription(server)}</span>
            </span>
            <button
              type="button"
              className="proposal-do"
              disabled={busy !== null || added.has(server.id)}
              onClick={() => void connect(server.id)}
            >
              {added.has(server.id) ? t("Added") : t("Connect")}
            </button>
          </li>
        ))}
      </ul>

      <div className="connectors-row">
        <span className="connectors-row-body">
          <span className="connectors-row-title">{t("Developer mode")}</span>
          <span className="connectors-row-meta">
            {t("Add any MCP server by its address. Only add servers you trust.")}
          </span>
        </span>
        <Switch
          checked={developer}
          aria-label={t("Developer mode")}
          onCheckedChange={(next) => {
            writeDeveloperMode(next);
            setDeveloper(next);
          }}
        />
      </div>
      {developer ? (
        <CustomConnectorForm
          busy={busy !== null}
          onAdd={(request) =>
            run("custom", async () => {
              const connector = await connectorAdd(request);
              if (connector.auth === "oauth") {
                followSignIn(connector.id, await connectorSignIn(connector.id));
              }
            })
          }
        />
      ) : null}
    </div>
  );
}

function builtinDescription(id: string): string {
  switch (id) {
    case "google":
      return t(
        "Calendar, contacts, and only the Drive files Sub Rosa created or that you opened with it.",
      );
    case "github":
      return t("Repositories, issues and pull requests, through GitHub's own MCP server.");
    default:
      return t("Outlook calendar and mail, and OneDrive.");
  }
}

/** The code a device sign-in shows: typed on the service's own page, in the
 * browser Sub Rosa opened, while the app waits for it. */
function DeviceCode({ sign, onDismiss }: { sign: DeviceSignIn; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="connector-device" role="status">
      <span className="connectors-row-meta">
        {t("Type this code on the page that opened in your browser. Sub Rosa finishes by itself.")}
      </span>
      <code className="connector-device-code">{sign.userCode}</code>
      <span className="connector-card-actions">
        <button
          type="button"
          className="proposal-do"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(sign.userCode)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
        >
          {copied ? t("Copied") : t("Copy code")}
        </button>
        <button
          type="button"
          className="proposal-do"
          onClick={() => void openExternalUrl(sign.verificationUri)}
        >
          {t("Open the page again")}
        </button>
        <button type="button" className="proposal-do" onClick={onDismiss}>
          {t("Hide")}
        </button>
      </span>
    </div>
  );
}

/** The start of an address, not copy. */
const ADDRESS_EXAMPLE = "https://";

/** The catalog's descriptions, as literal sentences the catalog translates.
 * A server this build does not know reads its English description. */
function catalogDescription(server: CatalogServer): string {
  switch (server.id) {
    case "notion":
      return t("Search, read and update pages and databases");
    case "linear":
      return t("Find, create and update issues and projects");
    case "sentry":
      return t("Look into errors, issues and releases");
    case "stripe":
      return t("Look up customers, payments and invoices");
    case "zapier":
      return t("Run the actions you set up in Zapier");
    case "square":
      return t("Look up orders, payments and catalog items");
    case "intercom":
      return t("Search conversations and contacts");
    case "monday":
      return t("Read and update boards and items");
    case "webflow":
      return t("Read and edit sites and CMS collections");
    case "huggingface":
      return t("Search models, datasets and papers");
    case "cloudflare-docs":
      return t("Search Cloudflare's documentation, no account needed");
    default:
      return server.description;
  }
}

function CustomConnectorForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (request: { name: string; url: string; auth: "oauth" | "none" | "token" }) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<"oauth" | "none" | "token">("oauth");
  return (
    <form
      className="connectors-form"
      aria-label={t("Add custom connector")}
      onSubmit={(event) => {
        event.preventDefault();
        if (!url.trim()) return;
        onAdd({ name: name.trim(), url: url.trim(), auth });
        setName("");
        setUrl("");
      }}
    >
      <h3 className="settings-row-title">{t("Add custom connector")}</h3>
      <input
        className="connectors-input"
        aria-label={t("Name")}
        placeholder={t("Name")}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <input
        className="connectors-input"
        aria-label={t("Server address")}
        placeholder={ADDRESS_EXAMPLE}
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        value={url}
        onChange={(event) => setUrl(event.currentTarget.value)}
      />
      <select
        className="connectors-input"
        aria-label={t("How it signs in")}
        value={auth}
        onChange={(event) => setAuth(event.currentTarget.value as typeof auth)}
      >
        <option value="oauth">{t("Sign in in the browser")}</option>
        <option value="token">{t("An access token")}</option>
        <option value="none">{t("No sign-in")}</option>
      </select>
      <button type="submit" className="proposal-do" disabled={busy || !url.trim()}>
        {t("Add")}
      </button>
    </form>
  );
}

function TokenForm({
  connector,
  onSaved,
  onError,
}: {
  connector: Connector;
  onSaved: () => void;
  onError: (text: string) => void;
}) {
  const [token, setToken] = useState("");
  return (
    <span className="connector-card-actions">
      <input
        className="connectors-input"
        type="password"
        autoComplete="off"
        aria-label={t("Access token for {name}", { name: connector.name })}
        placeholder={t("Access token")}
        value={token}
        onChange={(event) => setToken(event.currentTarget.value)}
      />
      <button
        type="button"
        className="proposal-do"
        disabled={!token.trim()}
        onClick={() =>
          void connectorSetToken(connector.id, token)
            .then(() => {
              setToken("");
              onSaved();
            })
            .catch((cause) =>
              onError(friendlyErrorMessage(cause, t("The token could not be saved."))),
            )
        }
      >
        {t("Save")}
      </button>
    </span>
  );
}
