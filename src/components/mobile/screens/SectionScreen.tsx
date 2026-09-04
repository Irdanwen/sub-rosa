import { type ReactNode, useEffect, useState } from "react";
import { diagnosticsReportText } from "../../../lib/diagnostics-report";
import { messageFromError } from "../../../lib/errors";
import { dispatchProviderModelSettingsChanged } from "../../../lib/model-privacy";
import {
  listVeniceModels,
  type ProviderModelMode,
  setVeniceModel,
  shareText,
  type VeniceModelDto,
} from "../../../lib/tauri";
import { ModelSheet } from "../ModelSheet";
import { APP_COMMIT_HASH, APP_VERSION } from "../../../app/build-info";
import { usePlatformCapabilities } from "../../../lib/platform-capabilities";
import { PrivacySettingsSection } from "../../settings/PrivacySettingsSection";
import { ArchiveSection } from "../../settings/ArchiveSection";
import { SettingsGroup, SettingsRow } from "../SettingsList";
import { StackHeader } from "../StackHeader";

/**
 * A settings section on the phone: the stack header, then a desktop section
 * reused as it is. The desktop components render plain settings markup, and
 * mobile.css already styles that markup inside `mobile-screen-root`, so the
 * phone gets the same words and the same facts (the egress list, the archive)
 * without a second implementation to keep true.
 */
export function SectionScreen({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mobile-screen-root">
      <StackHeader title={title} onBack={onBack} backLabel="Settings" />
      <div className="mobile-scroll mobile-settings-section">{children}</div>
    </div>
  );
}

export function PrivacyScreen({ onBack }: { onBack: () => void }) {
  return (
    <SectionScreen title="Privacy" onBack={onBack}>
      <PrivacySettingsSection />
    </SectionScreen>
  );
}

export function ArchiveScreen({ onBack }: { onBack: () => void }) {
  return (
    <SectionScreen title="Archive" onBack={onBack}>
      <ArchiveSection />
    </SectionScreen>
  );
}

export function AboutScreen({ onBack }: { onBack: () => void }) {
  const caps = usePlatformCapabilities();
  return (
    <SectionScreen title="About" onBack={onBack}>
      <SettingsGroup title="Sub Rosa">
        <SettingsRow label="Version">
          <span className="mobile-settings-value">{APP_VERSION}</span>
        </SettingsRow>
        <SettingsRow label="Build">
          <span className="mobile-settings-value">{APP_COMMIT_HASH}</span>
        </SettingsRow>
        <SettingsRow label="Platform">
          <span className="mobile-settings-value">{caps?.platform ?? "…"}</span>
        </SettingsRow>
      </SettingsGroup>
      <p className="mobile-settings-footnote">
        Your notes, transcripts and memories stay on this phone. Requests go to the Carpe Diem
        endpoint you configured, and nowhere else.
      </p>
    </SectionScreen>
  );
}

/**
 * The diagnostics report, readable before it is shared: what the desktop
 * writes to a folder, the phone hands to the share sheet as text.
 */
export function ReportsScreen({ onBack }: { onBack: () => void }) {
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    diagnosticsReportText()
      .then(setReport)
      .catch((err) => setError(messageFromError(err)));
  }, []);
  return (
    <SectionScreen title="Reports" onBack={onBack}>
      <SettingsGroup title="Diagnostics">
        <p className="mobile-settings-note">
          Versions, platform, storage and the local backend's state. No note, no transcript, no key.
          Read it, then share it with whoever is helping you.
        </p>
        {error ? <p className="mobile-settings-error">{error}</p> : null}
        {report ? (
          <>
            <pre className="mobile-report">{report}</pre>
            <button
              type="button"
              className="mobile-settings-button"
              onClick={() => void shareText(report)}
            >
              Share report
            </button>
          </>
        ) : (
          <p className="mobile-settings-note">Gathering the report…</p>
        )}
      </SettingsGroup>
    </SectionScreen>
  );
}

const MODEL_ROWS: Array<{ mode: ProviderModelMode; label: string; note: string }> = [
  { mode: "generation", label: "Text", note: "Writes notes, answers, summaries." },
  { mode: "transcription", label: "Transcription", note: "Turns recordings into text." },
  { mode: "image", label: "Image", note: "Studio images and edits." },
];

/**
 * The default model per kind of work, the same three the desktop's Models
 * tab sets. A chat, a flow or a Studio panel can still pick its own; this
 * is what they start from.
 */
export function ModelsScreen({ onBack }: { onBack: () => void }) {
  const [catalog, setCatalog] = useState<
    Partial<Record<ProviderModelMode, { selected: string; models: VeniceModelDto[] }>>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<ProviderModelMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    for (const row of MODEL_ROWS) {
      listVeniceModels(row.mode)
        .then((response) => {
          if (cancelled) return;
          setCatalog((current) => ({
            ...current,
            [row.mode]: { selected: response.selectedModel, models: response.models },
          }));
        })
        .catch((err) => {
          if (!cancelled) setError(messageFromError(err));
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  async function choose(mode: ProviderModelMode, modelId: string) {
    setPicking(null);
    try {
      await setVeniceModel(mode, modelId);
      setCatalog((current) => {
        const entry = current[mode];
        return entry ? { ...current, [mode]: { ...entry, selected: modelId } } : current;
      });
      dispatchProviderModelSettingsChanged({ mode, modelId });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  const active = picking ? catalog[picking] : undefined;
  return (
    <SectionScreen title="Models" onBack={onBack}>
      <SettingsGroup title="Default models">
        <p className="mobile-settings-note">
          What each kind of work starts with. A chat, a flow or a Studio panel can still pick its
          own model for one run.
        </p>
        {error ? <p className="mobile-settings-error">{error}</p> : null}
        {MODEL_ROWS.map((row) => {
          const entry = catalog[row.mode];
          const name =
            entry?.models.find((model) => model.id === entry.selected)?.name ??
            entry?.selected ??
            "…";
          return (
            <SettingsRow key={row.mode} label={row.label} align="stack">
              <button
                type="button"
                className="mobile-settings-button"
                disabled={!entry}
                onClick={() => setPicking(row.mode)}
                aria-label={`${row.label} model: ${name}`}
              >
                {name}
              </button>
              <p className="mobile-settings-footnote">{row.note}</p>
            </SettingsRow>
          );
        })}
      </SettingsGroup>
      {picking && active ? (
        <ModelSheet
          title={`${MODEL_ROWS.find((row) => row.mode === picking)?.label ?? ""} model`}
          entries={active.models.map((model) => ({
            id: model.id,
            name: model.name,
            subtitle: model.description,
          }))}
          selectedId={active.selected}
          onSelect={(id) => void choose(picking, id)}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </SectionScreen>
  );
}
