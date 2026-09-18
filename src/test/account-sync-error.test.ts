import { describe, expect, it } from "vitest";
import { accountSyncError } from "../lib/account-sync-error";

/** Every code the native side can emit, read off the Rust sources. */
const EMITTED = [
  "sync_authentication_failed",
  "sync_blob_invalid",
  "sync_blob_request_failed",
  "sync_conflict_requires_review",
  "sync_dependencies_pending",
  "sync_file_changed",
  "sync_file_too_large",
  "sync_file_type_unsupported",
  "sync_file_unavailable",
  "sync_format_invalid",
  "sync_local_work_active",
  "sync_object_too_large",
  "sync_pending_changes",
  "sync_resolution_invalid",
  "sync_timeout",
];

describe("what a failed synchronization says", () => {
  const fallback = accountSyncError("something_new");

  it("explains every code the native side can emit", () => {
    const unexplained = EMITTED.filter((code) => accountSyncError(code) === fallback);
    expect(unexplained).toEqual([]);
  });

  it("still has something to say about a code it has never seen", () => {
    expect(fallback).toMatch(/local copies are preserved/);
  });

  it("does not tell someone to retry work that finishes on its own", () => {
    for (const code of [
      "sync_local_work_active",
      "sync_pending_changes",
      "sync_dependencies_pending",
    ]) {
      expect(accountSyncError(code)).not.toMatch(/Try again/);
    }
  });

  it("names no file, host or native detail", () => {
    for (const code of [...EMITTED, "something_new"]) {
      expect(accountSyncError(code)).not.toMatch(/[/\\]|https?:|\.rs\b/);
    }
  });
});
