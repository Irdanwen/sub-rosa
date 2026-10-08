import { type FormEvent, useCallback, useEffect, useState } from "react";
import { t } from "../../../lib/i18n";
import type { FeatureHost } from "../../feature";
import { connectorOptions, envFor } from "../env";
import type { ToolInfo } from "../mcp";
import { effectiveRule, type Rule } from "../rules";
import { beginSignIn, hasCredential, refreshTools, setToken, signOut } from "../runtime";
import { tokensSlot } from "../secrets";
import {
  addConnector,
  type Connector,
  connectorFor,
  developerMode,
  forgetLocal,
  type LocalState,
  listConnectors,
  localState,
  removeConnector,
  setDeveloperMode,
  setEnabled,
  setToolRule,
} from "../store";
import { deleteTrigger, listTriggers, saveTrigger, type TriggerRecord } from "../triggers";
import { reachableFromWeb } from "../turn";
import { CONNECTORS, PROBED_AT, webAvailability, webRefusal } from "../words";
import { failureText, unavailableReason } from "./words";
import "./connectors.css";

interface Row {
  connector: Connector;
  local: LocalState;
  signedIn: boolean;
}

function ruleLabel(rule: Rule) {
  return rule === "allow"
    ? t("Allow", "Autoriser")
    : rule === "ask"
      ? t("Ask first", "Demander d’abord")
      : t("Off", "Désactivé");
}

/** Settings › Connectors, in the browser. */
export function ConnectorsPanel({ host }: { host: FeatureHost }) {
  const env = envFor(host);
  const [rows, setRows] = useState<Row[]>([]);
  const [developer, setDeveloper] = useState(false);
  const [triggers, setTriggers] = useState<TriggerRecord[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const connectors = listConnectors(host.sync);
  const signature = JSON.stringify(connectors);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` is the connectors' content.
  const reload = useCallback(async () => {
    const next: Row[] = [];
    for (const connector of listConnectors(host.sync))
      next.push({
        connector,
        local: await localState(env.store, connector.id),
        signedIn: await hasCredential(env, connector),
      });
    setRows(next);
    setDeveloper(await developerMode(env.store));
    setTriggers(await listTriggers(env.store));
  }, [signature]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (label: string, work: () => Promise<void>) => {
    setError("");
    setBusy(label);
    try {
      await work();
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setBusy("");
      host.refresh();
      await reload();
    }
  };

  const signIn = (connector: Connector) =>
    act(connector.id, async () => {
      const next = await beginSignIn(env, connector);
      if (next.kind === "browser") connectorOptions().navigate(next.url);
      else await refreshTools(env, connector);
    });

  const added = new Set(connectors.map((connector) => connector.catalogId || connector.id));
  return (
    <div className="cn-section">
      <h1>{t("Connectors", "Connecteurs")}</h1>
      <p className="quiet">
        {t(
          "Connectors let the assistant read and act in your other services. Their definitions travel with your account; each browser signs in on its own, and its access stays in this browser, sealed.",
          "Les connecteurs permettent à l’assistant de lire et d’agir dans vos autres services. Leurs définitions suivent votre compte ; chaque navigateur se connecte lui-même, et son accès reste dans ce navigateur, scellé.",
        )}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <h2>{t("Your connectors", "Vos connecteurs")}</h2>
      {rows.length === 0 && (
        <p className="quiet">{t("No connector yet.", "Aucun connecteur pour l’instant.")}</p>
      )}
      <ul className="cn-list">
        {rows.map(({ connector, local, signedIn }) => {
          const reachable = reachableFromWeb(connector);
          const reason = webRefusal(connector);
          return (
            <li key={connector.id} className="cn-item" data-available={reachable}>
              <div className="wc-row">
                <strong>{connector.name}</strong>
                <span className="quiet">
                  {!reachable
                    ? t("Not available in the browser", "Indisponible dans le navigateur")
                    : !connector.enabled
                      ? t("Off", "Désactivé")
                      : local.status === "needs_sign_in" || !signedIn
                        ? t("Not signed in here", "Pas connecté ici")
                        : local.status === "error"
                          ? t("Unreachable", "Injoignable")
                          : t("Connected", "Connecté")}
                </span>
              </div>
              {!reachable && <p className="quiet">{unavailableReason(reason)}</p>}
              <div className="wc-row">
                {reachable && connector.auth === "oauth" && (
                  <button
                    className="button"
                    type="button"
                    disabled={busy !== ""}
                    onClick={() => void signIn(connector)}
                  >
                    {signedIn ? t("Sign in again", "Se reconnecter") : t("Sign in", "Se connecter")}
                  </button>
                )}
                {reachable && signedIn && (
                  <button
                    className="button"
                    type="button"
                    disabled={busy !== ""}
                    onClick={() =>
                      void act(connector.id, () =>
                        refreshTools(env, connector).then(() => undefined),
                      )
                    }
                  >
                    {t("Refresh tools", "Actualiser les outils")}
                  </button>
                )}
                {reachable && connector.auth === "token" && (
                  <TokenForm
                    onSave={(token) => act(connector.id, () => setToken(env, connector.id, token))}
                  />
                )}
                <button
                  className="button"
                  type="button"
                  disabled={busy !== ""}
                  onClick={() =>
                    void act(connector.id, () =>
                      setEnabled(host.sync, connector.id, !connector.enabled),
                    )
                  }
                >
                  {connector.enabled ? t("Turn off", "Désactiver") : t("Turn on", "Activer")}
                </button>
                {signedIn && connector.auth !== "none" && (
                  <button
                    className="button"
                    type="button"
                    disabled={busy !== ""}
                    onClick={() => void act(connector.id, () => signOut(env, connector.id))}
                  >
                    {t("Sign out here", "Se déconnecter ici")}
                  </button>
                )}
                <button
                  className="button"
                  type="button"
                  disabled={busy !== ""}
                  onClick={() =>
                    void act(connector.id, async () => {
                      await removeConnector(host.sync, connector.id);
                      await env.secrets.delete(tokensSlot(connector.id));
                      await forgetLocal(env.store, connector.id);
                    })
                  }
                >
                  {t("Remove", "Retirer")}
                </button>
              </div>
              {local.tools.length > 0 && (
                <ToolRules
                  tools={local.tools}
                  rule={(tool) => effectiveRule(connector.toolPolicy, tool)}
                  onRule={(tool, rule) =>
                    void act(connector.id, () => setToolRule(host.sync, connector.id, tool, rule))
                  }
                />
              )}
            </li>
          );
        })}
      </ul>

      <h2>{t("Catalog", "Catalogue")}</h2>
      <p className="quiet">
        {t(
          `Checked from a browser on ${PROBED_AT}. A service that refuses web pages works only in the app.`,
          `Vérifié depuis un navigateur le ${PROBED_AT}. Un service qui refuse les pages web ne fonctionne que dans l’app.`,
        )}
      </p>
      <ul className="cn-list">
        {CONNECTORS.catalog.map((entry) => {
          const available = webAvailability(entry.id);
          return (
            <li key={entry.id} className="cn-item" data-available={available.web}>
              <div className="wc-row">
                <strong>{entry.name}</strong>
                <span className="quiet">{entry.description}</span>
              </div>
              {available.web ? (
                <div className="wc-row">
                  <button
                    className="button"
                    type="button"
                    disabled={added.has(entry.id) || busy !== ""}
                    onClick={() =>
                      void act(entry.id, () =>
                        addConnector(host.sync, connectorFor({ catalogId: entry.id })),
                      )
                    }
                  >
                    {added.has(entry.id) ? t("Added", "Ajouté") : t("Add", "Ajouter")}
                  </button>
                </div>
              ) : (
                <p className="quiet">{unavailableReason(available.reason)}</p>
              )}
            </li>
          );
        })}
      </ul>

      <h2>{t("Developer mode", "Mode développeur")}</h2>
      <label className="wc-row">
        <input
          type="checkbox"
          checked={developer}
          onChange={(event) =>
            void act("developer", () => setDeveloperMode(env.store, event.target.checked))
          }
        />
        {t(
          "Add a connector by its address, with a token if it needs one",
          "Ajouter un connecteur par son adresse, avec un jeton s’il en faut un",
        )}
      </label>
      {developer && (
        <CustomForm
          onAdd={(request) =>
            act("custom", async () => {
              const connector = connectorFor(request);
              await addConnector(host.sync, connector);
              if (request.auth === "token" && request.token)
                await setToken(env, connector.id, request.token);
            })
          }
        />
      )}

      <h2>{t("When this happens", "Quand ceci arrive")}</h2>
      <Triggers
        host={host}
        triggers={triggers}
        connectors={rows
          .filter((row) => reachableFromWeb(row.connector))
          .map((row) => row.connector)}
        onSave={(trigger) => act("trigger", () => saveTrigger(env.store, trigger))}
        onDelete={(id) => act("trigger", () => deleteTrigger(env.store, id))}
      />
    </div>
  );
}

function ToolRules({
  tools,
  rule,
  onRule,
}: {
  tools: ToolInfo[];
  rule: (tool: ToolInfo) => Rule;
  onRule: (tool: string, rule: Rule) => void;
}) {
  return (
    <details>
      <summary>
        {tools.length === 1
          ? t("1 tool", "1 outil")
          : t(`${tools.length} tools`, `${tools.length} outils`)}
      </summary>
      <div className="cn-tools">
        {tools.map((tool) => (
          <label key={tool.name} className="cn-tool-row">
            <span>{tool.title ?? tool.name}</span>
            <select
              value={rule(tool)}
              onChange={(event) => onRule(tool.name, event.target.value as Rule)}
            >
              {(["allow", "ask", "deny"] as Rule[]).map((value) => (
                <option key={value} value={value}>
                  {ruleLabel(value)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </details>
  );
}

function TokenForm({ onSave }: { onSave: (token: string) => void }) {
  const [token, setTokenText] = useState("");
  return (
    <form
      className="wc-row"
      onSubmit={(event) => {
        event.preventDefault();
        if (token.trim()) onSave(token);
        setTokenText("");
      }}
    >
      <label className="sr-only" htmlFor="cn-token">
        {t("Access token", "Jeton d’accès")}
      </label>
      <input
        id="cn-token"
        type="password"
        autoComplete="off"
        value={token}
        placeholder={t("Access token", "Jeton d’accès")}
        onChange={(event) => setTokenText(event.target.value)}
      />
      <button className="button" type="submit" disabled={!token.trim()}>
        {t("Save the token", "Enregistrer le jeton")}
      </button>
    </form>
  );
}

function CustomForm({
  onAdd,
}: {
  onAdd: (request: { name: string; url: string; auth: string; token: string }) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState("oauth");
  const [token, setTokenText] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onAdd({ name, url, auth, token });
    setName("");
    setUrl("");
    setTokenText("");
  };
  return (
    <form className="cn-form" onSubmit={submit}>
      <label>
        {t("Name", "Nom")}
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        {t("Address", "Adresse")}
        <input
          type="url"
          required
          value={url}
          placeholder="https://"
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <label>
        {t("Sign-in", "Connexion")}
        <select value={auth} onChange={(event) => setAuth(event.target.value)}>
          <option value="oauth">
            {t("Sign in with the service", "Se connecter avec le service")}
          </option>
          <option value="none">{t("No sign-in", "Sans connexion")}</option>
          <option value="token">{t("Access token", "Jeton d’accès")}</option>
        </select>
      </label>
      {auth === "token" && (
        <label>
          {t("Access token", "Jeton d’accès")}
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setTokenText(event.target.value)}
          />
        </label>
      )}
      <p className="quiet">
        {t(
          "The service must accept requests from this site, or the browser cannot reach it.",
          "Le service doit accepter les requêtes de ce site, sinon le navigateur ne peut pas le joindre.",
        )}
      </p>
      <div className="wc-row">
        <button className="button primary" type="submit" disabled={!url.trim()}>
          {t("Add the connector", "Ajouter le connecteur")}
        </button>
      </div>
    </form>
  );
}

function Triggers({
  host,
  triggers,
  connectors,
  onSave,
  onDelete,
}: {
  host: FeatureHost;
  triggers: TriggerRecord[];
  connectors: Connector[];
  onSave: (trigger: Omit<TriggerRecord, "seen" | "armed" | "lastCheckedAt" | "lastError">) => void;
  onDelete: (id: string) => void;
}) {
  const assignments = host.sync
    .rows("assignments")
    .map((object) => ({ id: object.id, title: String(object.row.title ?? object.id) }));
  const [assignmentId, setAssignmentId] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [kind, setKind] = useState<"tool_poll" | "resource_updated">("tool_poll");
  const [target, setTarget] = useState("");
  if (!assignments.length)
    return (
      <p className="quiet">
        {t(
          "Create an assignment first: a trigger starts one of its runs while this page is open.",
          "Créez d’abord une mission : un déclencheur lance une de ses exécutions tant que cette page est ouverte.",
        )}
      </p>
    );
  return (
    <div className="cn-section">
      <p className="quiet">
        {t(
          "A trigger looks every five minutes while this page is open. Its first look only learns what is already there.",
          "Un déclencheur regarde toutes les cinq minutes tant que cette page est ouverte. Son premier regard apprend seulement ce qui existe déjà.",
        )}
      </p>
      <ul className="cn-list">
        {triggers.map((trigger) => (
          <li key={trigger.id} className="cn-item">
            <div className="wc-row">
              <strong>
                {assignments.find((item) => item.id === trigger.assignmentId)?.title ??
                  trigger.assignmentId}
              </strong>
              <span className="quiet">{trigger.config.tool ?? trigger.config.uri}</span>
              <button className="button" type="button" onClick={() => onDelete(trigger.id)}>
                {t("Remove", "Retirer")}
              </button>
            </div>
            {trigger.lastError && <p className="quiet">{trigger.lastError}</p>}
          </li>
        ))}
      </ul>
      <form
        className="cn-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!assignmentId || !connectorId || !target.trim()) return;
          onSave({
            id: crypto.randomUUID(),
            assignmentId,
            connectorId,
            kind,
            config:
              kind === "tool_poll"
                ? { tool: target.trim(), arguments: {} }
                : { uri: target.trim() },
          });
          setTarget("");
        }}
      >
        <label>
          {t("Assignment", "Mission")}
          <select value={assignmentId} onChange={(event) => setAssignmentId(event.target.value)}>
            <option value="">{t("Choose", "Choisir")}</option>
            {assignments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Connector", "Connecteur")}
          <select value={connectorId} onChange={(event) => setConnectorId(event.target.value)}>
            <option value="">{t("Choose", "Choisir")}</option>
            {connectors.map((connector) => (
              <option key={connector.id} value={connector.id}>
                {connector.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("What to watch", "Ce qu’il faut surveiller")}
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as "tool_poll" | "resource_updated")}
          >
            <option value="tool_poll">
              {t("New items a tool lists", "Les nouveaux éléments d’un outil")}
            </option>
            <option value="resource_updated">
              {t("A resource that changes", "Une ressource qui change")}
            </option>
          </select>
        </label>
        <label>
          {kind === "tool_poll"
            ? t("Tool name", "Nom de l’outil")
            : t("Resource address", "Adresse de la ressource")}
          <input value={target} onChange={(event) => setTarget(event.target.value)} />
        </label>
        <div className="wc-row">
          <button className="button" type="submit">
            {t("Add the trigger", "Ajouter le déclencheur")}
          </button>
        </div>
      </form>
    </div>
  );
}
