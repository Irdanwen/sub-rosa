import { describe, expect, it, vi } from "vitest";
import {
  UPDATE_CHECK_INTERVAL_MS,
  checkForJuneUpdate,
  installJuneUpdate,
  prepareJuneUpdate,
  startPeriodicJuneUpdateChecks,
  type UpdaterUpdate,
  releaseNoteLines,
} from "../app/update-decision";

function update(body?: string): UpdaterUpdate {
  return {
    version: "0.2.0",
    body,
    downloadAndInstall: vi.fn(async (onEvent) => {
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 40 } });
      onEvent?.({ event: "Finished" });
    }),
  };
}

describe("checkForJuneUpdate", () => {
  it("prompts with version and release notes when an update is available", async () => {
    const prompt = vi.fn();

    await checkForJuneUpdate(
      {
        check: async () => update(" Fixes transcription. "),
        prompt,
        reportNoUpdate: vi.fn(),
        reportFailure: vi.fn(),
      },
      "launch",
    );

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "0.2.0",
        notes: "Fixes transcription.",
      }),
    );
  });

  it("does not prompt when no update is available", async () => {
    const prompt = vi.fn();
    const reportNoUpdate = vi.fn();

    await checkForJuneUpdate(
      {
        check: async () => null,
        prompt,
        reportNoUpdate,
        reportFailure: vi.fn(),
      },
      "launch",
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(reportNoUpdate).not.toHaveBeenCalled();
  });

  it("keeps periodic no-update checks silent", async () => {
    const prompt = vi.fn();
    const reportNoUpdate = vi.fn();

    await checkForJuneUpdate(
      {
        check: async () => null,
        prompt,
        reportNoUpdate,
        reportFailure: vi.fn(),
      },
      "periodic",
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(reportNoUpdate).not.toHaveBeenCalled();
  });

  it("reports no update for a manual check", async () => {
    const reportNoUpdate = vi.fn();

    await checkForJuneUpdate(
      {
        check: async () => null,
        prompt: vi.fn(),
        reportNoUpdate,
        reportFailure: vi.fn(),
      },
      "manual",
    );

    expect(reportNoUpdate).toHaveBeenCalledTimes(1);
  });

  it("reports failures without claiming success", async () => {
    const prompt = vi.fn();
    const reportFailure = vi.fn();

    await checkForJuneUpdate(
      {
        check: async () => {
          throw new Error("signature mismatch");
        },
        prompt,
        reportNoUpdate: vi.fn(),
        reportFailure,
      },
      "manual",
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith("signature mismatch");
  });
});

describe("startPeriodicJuneUpdateChecks", () => {
  it("runs periodic checks until stopped", () => {
    vi.useFakeTimers();
    const runUpdateCheck = vi.fn();

    try {
      const stop = startPeriodicJuneUpdateChecks(runUpdateCheck);

      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS - 1);
      expect(runUpdateCheck).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(runUpdateCheck).toHaveBeenCalledWith("periodic");
      expect(runUpdateCheck).toHaveBeenCalledTimes(1);

      stop();
      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
      expect(runUpdateCheck).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("installJuneUpdate", () => {
  it("reports download progress, installs, and relaunches", async () => {
    const candidate = update("notes");
    const relaunch = vi.fn(async () => undefined);
    const reportProgress = vi.fn();

    await installJuneUpdate({
      update: candidate,
      relaunch,
      reportProgress,
      reportFailure: vi.fn(),
    });

    expect(candidate.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(reportProgress).toHaveBeenCalledWith({
      state: "downloading",
      downloadedBytes: 40,
      contentLength: 100,
    });
    expect(reportProgress).toHaveBeenCalledWith({
      state: "installing",
      downloadedBytes: 40,
      contentLength: 100,
    });
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});

describe("prepareJuneUpdate", () => {
  it("reports download progress and marks the update ready without relaunching", async () => {
    const candidate = update(" Ready after relaunch. ");
    const reportProgress = vi.fn();
    const reportReady = vi.fn();

    await prepareJuneUpdate({
      update: candidate,
      reportProgress,
      reportReady,
      reportFailure: vi.fn(),
    });

    expect(candidate.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(reportProgress).toHaveBeenCalledWith({
      state: "downloading",
      downloadedBytes: 40,
      contentLength: 100,
    });
    expect(reportProgress).toHaveBeenCalledWith({
      state: "installing",
      downloadedBytes: 40,
      contentLength: 100,
    });
    expect(reportReady).toHaveBeenCalledWith({
      update: candidate,
      version: "0.2.0",
      notes: "Ready after relaunch.",
    });
  });
});

describe("releaseNoteLines", () => {
  const notes = [
    "## Sub Rosa v1.59.0",
    "",
    "Changes since v1.58.0.",
    "",
    "### Changes",
    "- fix(ci): pin the supply-chain tools to the versions that were validated",
    "- ci: sync upstream with the fork's own workflows",
    "- feat(notes): a note can be read, not only written",
    "- chore(deps): close four advisories",
    "- design(app): nothing waits, or fails, without saying so",
  ].join("\n");

  it("keeps the bullets, drops the headings, and strips the conventional prefix", () => {
    expect(releaseNoteLines(notes)).toEqual([
      "Pin the supply-chain tools to the versions that were validated",
      "Sync upstream with the fork's own workflows",
      "A note can be read, not only written",
      "Close four advisories",
    ]);
  });

  it("honours the limit and survives notes without bullets", () => {
    expect(releaseNoteLines(notes, 2)).toHaveLength(2);
    expect(releaseNoteLines("Sub Rosa v1.58.0")).toEqual([]);
    expect(releaseNoteLines(undefined)).toEqual([]);
  });
});
