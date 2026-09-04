import { invoke } from "@tauri-apps/api/core";

/** The diagnostics report as text (versions, platform, storage; no content). */
export async function diagnosticsReportText(): Promise<string> {
  return invoke<string>("diagnostics_report_text");
}
