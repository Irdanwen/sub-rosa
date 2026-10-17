// The versions of a workflow the person kept (⌘S), newest first: named,
// compared with the graph as it is now, gone back to, or let go. Going back
// keeps the graph it replaces as a version first, so nothing is lost.

import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { useEffect, useState } from "react";
import { intlLocale, t } from "../../../lib/i18n";
import type { Workflow } from "../../../lib/studio/workflow/schema";
import {
  deleteVersion,
  diffSummary,
  graphDiff,
  listVersions,
  renameVersion,
  type VersionEntry,
  versionGraph,
} from "../../../lib/studio/workflow/versions";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { EmptyState } from "../../ui/EmptyState";
import { Spinner } from "../../ui/Spinner";

export function VersionsPanel({
  workflow,
  refreshKey,
  onSave,
  onRestore,
  onClose,
}: {
  /** The workflow as it is now. */
  workflow: Workflow;
  /** Changes when a version is saved, so the list is read again. */
  refreshKey: unknown;
  onSave: () => void;
  onRestore: (version: VersionEntry, graph: Workflow) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<VersionEntry[] | undefined>(undefined);
  const [compared, setCompared] = useState<Record<string, string>>({});
  const [restoring, setRestoring] = useState<VersionEntry>();
  const [deleting, setDeleting] = useState<VersionEntry>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey asks for a fresh read.
  useEffect(() => {
    let cancelled = false;
    void listVersions(workflow.id)
      .then((loaded) => {
        if (!cancelled) setEntries(loaded);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workflow.id, refreshKey]);
  const when = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" });
  const compare = async (entry: VersionEntry) => {
    const graph = await versionGraph(entry.id, workflow);
    setCompared((now) => ({
      ...now,
      [entry.id]: graph
        ? t("Since then: {changes}", { changes: diffSummary(graphDiff(graph, workflow)) })
        : t("This version can no longer be read."),
    }));
  };
  return (
    <section className="studio-run-history" aria-label={t("Versions")}>
      <header className="studio-run-history-head">
        <h3>{t("Versions")}</h3>
        <span className="studio-card-actions">
          <button type="button" className="btn btn-secondary" title="⌘S" onClick={onSave}>
            {t("Save a version")}
          </button>
          <button
            type="button"
            className="studio-icon-button"
            aria-label={t("Close")}
            onClick={onClose}
          >
            <IconCrossSmall size={14} />
          </button>
        </span>
      </header>
      {entries === undefined ? (
        <Spinner aria-label={t("Loading")} />
      ) : entries.length === 0 ? (
        <EmptyState
          size="compact"
          title={t("No version kept yet.")}
          description={t("Save one with ⌘S before a change you might want to undo later.")}
        />
      ) : (
        <ul className="studio-run-history-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <div className="studio-run-history-line">
                <input
                  className="studio-input"
                  aria-label={t("Version name")}
                  defaultValue={entry.label}
                  onBlur={(event) => {
                    const label = event.currentTarget.value.trim();
                    if (label && label !== entry.label)
                      void renameVersion(entry.id, label).then(() =>
                        setEntries((now) =>
                          now?.map((item) => (item.id === entry.id ? { ...item, label } : item)),
                        ),
                      );
                  }}
                />
                <span className="studio-run-history-when">
                  {when.format(new Date(entry.createdAt))}
                </span>
              </div>
              {compared[entry.id] ? (
                <p className="studio-run-history-meta">{compared[entry.id]}</p>
              ) : null}
              <div className="studio-run-history-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void compare(entry)}
                >
                  {t("Compare with now")}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setRestoring(entry)}
                >
                  {t("Go back to it")}
                </button>
                <button
                  type="button"
                  className="studio-icon-button"
                  aria-label={t("Delete {name}", { name: entry.label })}
                  onClick={() => setDeleting(entry)}
                >
                  <IconCrossSmall size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={restoring !== undefined}
        onClose={() => setRestoring(undefined)}
        title={t("Go back to this version?")}
        description={t(
          "The canvas takes this version's steps and settings. The graph as it is now is kept as a version first.",
        )}
        confirmLabel={t("Go back")}
        onConfirm={() => {
          const entry = restoring;
          setRestoring(undefined);
          if (!entry) return;
          void versionGraph(entry.id, workflow).then((graph) => {
            if (graph) onRestore(entry, graph);
          });
        }}
      />
      <ConfirmDialog
        open={deleting !== undefined}
        onClose={() => setDeleting(undefined)}
        title={t("Delete this version?")}
        description={t("The workflow stays as it is.")}
        confirmLabel={t("Delete")}
        destructive
        onConfirm={() => {
          const entry = deleting;
          setDeleting(undefined);
          if (entry)
            void deleteVersion(entry.id).then(() =>
              setEntries((now) => now?.filter((item) => item.id !== entry.id)),
            );
        }}
      />
    </section>
  );
}
