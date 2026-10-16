import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RECORDING_SOURCE_MODE,
  RECORDING_SOURCE_MODE_STORAGE_KEY,
  readPreferredSourceMode,
  resolveRecordingStart,
  shouldRetryWithMicrophone,
  writePreferredSourceMode,
} from "../lib/recording-source-mode";
import { startingRecordingStatus } from "../lib/recording-status";
import { mergeSourceReadiness } from "../lib/source-readiness";
import type {
  RecordingSourceMode,
  RecordingSourceReadinessDto,
  SourceReadinessDto,
} from "../lib/tauri";

function lane(
  source: SourceReadinessDto["source"],
  overrides: Partial<SourceReadinessDto> = {},
): SourceReadinessDto {
  return {
    source,
    required: true,
    ready: true,
    permissionState: "granted",
    deviceAvailable: true,
    captureAvailable: true,
    ...overrides,
  };
}

function readiness(
  sourceMode: RecordingSourceMode,
  microphone: Partial<SourceReadinessDto> = {},
  system: Partial<SourceReadinessDto> = {},
): RecordingSourceReadinessDto {
  return {
    sourceMode,
    ready: true,
    sources: [lane("microphone", microphone), lane("system", system)],
  };
}

describe("the remembered source mode", () => {
  beforeEach(() => {
    localStorage.removeItem(RECORDING_SOURCE_MODE_STORAGE_KEY);
  });

  it("defaults to the microphone and the computer", () => {
    expect(readPreferredSourceMode()).toBe("microphonePlusSystem");
    expect(DEFAULT_RECORDING_SOURCE_MODE).toBe("microphonePlusSystem");
  });

  it("remembers each of the three choices", () => {
    for (const mode of ["microphoneOnly", "systemOnly", "microphonePlusSystem"] as const) {
      writePreferredSourceMode(mode);
      expect(readPreferredSourceMode()).toBe(mode);
    }
  });

  it("ignores a value it does not know", () => {
    localStorage.setItem(RECORDING_SOURCE_MODE_STORAGE_KEY, "everything");
    expect(readPreferredSourceMode()).toBe(DEFAULT_RECORDING_SOURCE_MODE);
  });
});

describe("resolveRecordingStart", () => {
  it("starts as asked when every lane the mode needs is ready", () => {
    for (const mode of ["microphonePlusSystem", "microphoneOnly", "systemOnly"] as const) {
      expect(resolveRecordingStart(mode, readiness(mode))).toEqual({
        kind: "start",
        mode,
        fellBack: false,
      });
    }
  });

  it("falls back to the microphone, visibly, when the computer is not available", () => {
    const decision = resolveRecordingStart(
      "microphonePlusSystem",
      readiness("microphonePlusSystem", {}, { ready: false, permissionState: "denied" }),
    );
    expect(decision).toEqual({ kind: "start", mode: "microphoneOnly", fellBack: true });
  });

  it("never opens the microphone for a computer-only take", () => {
    const decision = resolveRecordingStart(
      "systemOnly",
      readiness("systemOnly", {}, { ready: false, message: "No output." }),
    );
    expect(decision).toEqual({ kind: "blocked", source: "system", message: "No output." });
  });

  it("does not need the microphone for a computer-only take", () => {
    const decision = resolveRecordingStart(
      "systemOnly",
      readiness("systemOnly", { ready: false, permissionState: "denied" }),
    );
    expect(decision).toEqual({ kind: "start", mode: "systemOnly", fellBack: false });
  });

  it("blocks a take that needs a microphone that is not ready", () => {
    const decision = resolveRecordingStart(
      "microphonePlusSystem",
      readiness("microphonePlusSystem", { ready: false, message: "Mic blocked." }),
    );
    expect(decision).toEqual({ kind: "blocked", source: "microphone", message: "Mic blocked." });
  });
});

describe("shouldRetryWithMicrophone", () => {
  it("retries a call whose computer side failed to start", () => {
    expect(
      shouldRetryWithMicrophone("microphonePlusSystem", "system_audio_capture_unavailable"),
    ).toBe(true);
    expect(shouldRetryWithMicrophone("microphonePlusSystem", "source_not_ready")).toBe(true);
  });

  it("never retries a computer-only take with the microphone", () => {
    expect(shouldRetryWithMicrophone("systemOnly", "system_audio_capture_unavailable")).toBe(false);
  });

  it("does not retry a failure that is not the computer's", () => {
    expect(shouldRetryWithMicrophone("microphonePlusSystem", "microphone_unavailable")).toBe(false);
    expect(shouldRetryWithMicrophone("microphonePlusSystem", undefined)).toBe(false);
  });
});

describe("startingRecordingStatus", () => {
  it("shows one starting lane per source the mode records", () => {
    const sources = (mode: RecordingSourceMode) =>
      startingRecordingStatus("note-1", mode).sources?.map((source) => source.source);
    expect(sources("microphonePlusSystem")).toEqual(["microphone", "system"]);
    expect(sources("microphoneOnly")).toEqual(["microphone"]);
    expect(sources("systemOnly")).toEqual(["system"]);
  });
});

describe("mergeSourceReadiness with a computer-only check", () => {
  it("takes the computer's assessment from a computer-only check", () => {
    const previous = readiness("microphonePlusSystem", {}, { ready: true });
    const next = readiness("systemOnly", {}, { ready: false, permissionState: "denied" });
    const merged = mergeSourceReadiness(previous, next);
    expect(merged.sources.find((source) => source.source === "system")?.permissionState).toBe(
      "denied",
    );
  });
});
