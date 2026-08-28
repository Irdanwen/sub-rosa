import { describe, expect, it } from "vitest";
import { describeJobFailure } from "../lib/studio/job-errors";

describe("reading a failed generation", () => {
  it("turns a lost job into the one thing to do about it", () => {
    // The real incident: a seedance render accepted, then dropped by the
    // operator 13s later. What the user saw was API vocabulary that reads
    // like data loss.
    const failure = describeJobFailure({
      message: "Unknown or expired queue_id — re-queue the job",
      status: 404,
    });
    expect(failure.retryable).toBe(true);
    expect(failure.text).toMatch(/start(ing)? it again/i);
    expect(failure.text).not.toMatch(/queue_id/);
    // The backend's own words survive for the tooltip and for bug reports.
    expect(failure.detail).toBe("Unknown or expired queue_id — re-queue the job");
  });

  it("recognises a lost job from its message when no status came with it", () => {
    // Rows written before the status column existed, and any backend that
    // answers this over a 200.
    for (const message of [
      "Unknown queue_id (expired or unknown to this operator)",
      "VIDEO_JOB_NOT_FOUND",
    ]) {
      expect(describeJobFailure({ message }).retryable).toBe(true);
    }
  });

  it("separates a revoked provider key from a refused request", () => {
    // 410 is a job whose provider key went away mid-render: nothing about the
    // request was wrong, so the same request is worth sending again.
    expect(describeJobFailure({ message: "Video key revoked", status: 410 }).retryable).toBe(true);
    // 400 is the request itself. Offering "start again" here would just spend
    // the user's time reproducing the same refusal.
    expect(describeJobFailure({ message: "duration Required", status: 400 }).retryable).toBe(false);
  });

  it("does not offer a retry that would only spend the same 402 again", () => {
    const failure = describeJobFailure({ message: "Insufficient credits", status: 402 });
    expect(failure.retryable).toBe(false);
    expect(failure.text).toMatch(/credits/i);
  });

  it("treats rate limits and backend faults as worth another go", () => {
    expect(describeJobFailure({ message: "slow down", status: 429 }).retryable).toBe(true);
    expect(describeJobFailure({ message: "upstream exploded", status: 503 }).retryable).toBe(true);
  });

  it("shows an unrecognised failure verbatim rather than inventing a summary", () => {
    // Flattening an unknown failure into friendly prose hides what happened,
    // which is worse than showing the backend's own sentence.
    const failure = describeJobFailure({ message: "The model refused this prompt." });
    expect(failure.text).toBe("The model refused this prompt.");
    expect(failure.retryable).toBe(false);
  });

  it("names the input at fault when the public tier refuses a face", () => {
    // The real incident, twice over: a reference sheet of portraits queued
    // against seedance 2.5 with the attestation ticked. The backend's own
    // sentence names no input, so the user is left to reword a prompt that
    // was never the problem - and the checkbox they ticked reads as broken.
    const failure = describeJobFailure({
      message: "The request was refused by the model's content moderation.",
      status: 400,
      model: "seedance-2-5-reference-to-video-basic",
    });
    expect(failure.text).toMatch(/recognisable person/i);
    expect(failure.text).toMatch(/whatever you attest/i);
    // Same request, same refusal: a retry button here only spends the user's
    // time.
    expect(failure.retryable).toBe(false);
    expect(failure.detail).toBe("The request was refused by the model's content moderation.");
  });

  it("keeps the claim honest on a model that has no such rule", () => {
    // Only the public `-basic` tier refuses people whatever is attested.
    // Telling a wan or a kling user to blame their reference photo would be
    // inventing a cause.
    const failure = describeJobFailure({
      message: "The request was refused by the model's content moderation.",
      model: "wan-3-0-reference-to-video",
    });
    expect(failure.text).not.toMatch(/recognisable person/i);
    expect(failure.text).toMatch(/content filter/i);
    expect(failure.retryable).toBe(false);
  });

  it("reads a moderation refusal even with no model to hand", () => {
    const failure = describeJobFailure({ message: "Blocked by content policy." });
    expect(failure.text).toMatch(/content filter/i);
    expect(failure.retryable).toBe(false);
  });

  it("does not mistake a lost job for a moderated one", () => {
    // Ordering: "queue_id" wins, and it is the retryable one of the two.
    expect(
      describeJobFailure({ message: "Unknown or expired queue_id", status: 404 }).retryable,
    ).toBe(true);
  });

  it("still says something when the backend said nothing at all", () => {
    expect(describeJobFailure({}).text).toBeTruthy();
    expect(describeJobFailure({ message: "   " }).text).toBeTruthy();
  });
});
