import "../../styles/connectors.css";
import { IconConnectors1 } from "central-icons/IconConnectors1";
import { useState } from "react";
import {
  type CatalogServer,
  type Connector,
  type ConnectorCatalog,
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
import { Switch } from "../ui/Switch";
import { ToolRules, connectorStateLabel } from "./ToolRules";

/** What the computer's agent runtime needs to hear about a catalog server:
 * the desktop adds it to Hermes's MCP servers and signs in there too. The
 * phones pass nothing. */
export type HermesConnectorBridge = {
  has: (name: string) => boolean;
  add: (server: CatalogServer) => Promise<boolean>;
  signIn: (name: string) => Promise<unknown>;
};

type Props = {
  connectors: Connector[] | null;
  catalog: ConnectorCatalog | null;
  refresh: () => void;
  hermes?: HermesConnectorBridge | null;
};

/**
 * Connectors, the same on both shells: the ones added, with their sign-in
 * and their tools' rules; the one-tap catalog; and, in developer mode, any
 * server by its address.
 */
export function ConnectorsPanel({ connectors, catalog, refresh, hermes }: Props) {
  const [open, setOpen] = useState<string | null>(null);
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

  const signIn = (connector: Connector) =>
    run(connector.id, async () => {
      const result = await connectorSignIn(connector.id);
      if (!result.connected) {
        setNotice({
          text: t("Finish signing in in your browser. Sub Rosa comes back by itself."),
          error: false,
        });
      }
    });

  const connectServer = (server: CatalogServer) =>
    run(server.id, async () => {
      const added = await connectorAdd({ catalogId: server.id });
      if (hermes && !hermes.has(server.id)) {
        // The computer's agent gets the same server, signed in through its
        // own runtime.
        if ((await hermes.add(server)) && server.auth === "oauth") {
          await hermes.signIn(server.id);
        }
        return;
      }
      const result = await connectorSignIn(added.id);
      if (!result.connected) {
        setNotice({
          text: t("Finish signing in in your browser. Sub Rosa comes back by itself."),
          error: false,
        });
      }
    });

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
                    onClick={() =>
                      void run(
                        connector.id,
                        () => connectorRemove(connector.id),
                        t("{name} removed.", { name: connector.name }),
                      )
                    }
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
              <span className="connectors-row-meta">
                {builtin.id === "google"
                  ? t(
                      "Calendar, contacts, and only the Drive files Sub Rosa created or that you opened with it.",
                    )
                  : t("Outlook calendar and mail, and OneDrive.")}
              </span>
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
                onClick={() =>
                  void run(builtin.id, async () => {
                    const connector = await connectorAdd({ catalogId: builtin.id });
                    await connectorSignIn(connector.id);
                  })
                }
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
              onClick={() => void connectServer(server)}
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
              if (connector.auth === "oauth") await connectorSignIn(connector.id);
            })
          }
        />
      ) : null}
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
