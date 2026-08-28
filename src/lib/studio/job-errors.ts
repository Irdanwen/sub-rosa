// Turning a backend's failure into something a user can act on.
//
// The backends answer failures in their own vocabulary, addressed to a client
// rather than to a person: "Unknown or expired queue_id - re-queue the job" is
// an accurate sentence that tells a user nothing about what they should do, and
// worse, reads like data loss when it usually is not.
//
// Two things are worth separating here, and the prose alone separates neither:
// whether the request itself was wrong (queue it again and it fails again) and
// whether the job merely went missing on the way (queue it again and it works).
// That is what the HTTP status is for - which is why the durable row now
// carries it.

import { seedancePersonMediaCaveat } from "./seedance";

export interface JobFailure {
  /** What to show in place of the backend's own words. */
  text: string;
  /** Whether queueing the very same request again is the sane next move. */
  retryable: boolean;
  /** The backend's own words, kept for the tooltip and for bug reports. */
  detail?: string;
}

/**
 * A job the operator no longer knows about.
 *
 * Two backend behaviours land here and neither is the user's doing. A job can
 * be dropped after it was accepted (the queue endpoint validates nothing, so a
 * refused payload is accepted first and discarded seconds later), and a job can
 * lose the provider key it was rendering under. Both answer some variation of
 * "unknown or expired queue id", and both are told to re-queue.
 */
function looksMissing(message: string): boolean {
  // The same failure arrives written three ways: as prose ("job not found"),
  // as a machine code (`VIDEO_JOB_NOT_FOUND`), and with the separator going
  // either way (`queue_id`, `queue id`). Flattening the separators reads all
  // of them, which matters because these are the codes the docs name.
  const text = message.toLowerCase().replace(/[_-]+/g, " ");
  return text.includes("queue id") || text.includes("job not found");
}

/**
 * A refusal by the model's own content filter, rather than a failure to render.
 *
 * Worth separating from every other 4xx for one reason: nothing about the
 * request was malformed, so there is no field to fix and no point in sending
 * it again. What has to change is an input the user chose - and on the models
 * this app ships, which input it is can usually be named.
 */
function looksModerated(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes("moderation") || text.includes("content policy");
}

/**
 * What to tell the user about a failed generation.
 *
 * Falls back to the backend's own message rather than inventing one: an
 * unrecognised failure is better shown verbatim than flattened into a friendly
 * sentence that hides what happened.
 */
export function describeJobFailure({
  message,
  status,
  model,
}: {
  message?: string;
  status?: number;
  /** The model the render was queued against, where the surface knows it. Some
   * refusals only make sense once you know which model refused. */
  model?: string;
}): JobFailure {
  const detail = message?.trim() || undefined;
  const raw = detail ?? "";

  // 404 and 410 both mean "this job is gone from the backend". The render was
  // never delivered, so nothing is lost by starting over, and the backend
  // itself asks for exactly that.
  if (status === 404 || status === 410 || looksMissing(raw)) {
    return {
      text: "The backend lost this job before it finished. Nothing was delivered, so starting it again is safe.",
      retryable: true,
      detail,
    };
  }
  if (looksModerated(raw)) {
    // The public seedance tier refuses media showing a recognisable person
    // whatever the caller attests, and in this app that is far and away the
    // most common way to meet a moderation refusal: the surfaces offer a
    // consent checkbox right next to a reference picker, so a user who has
    // ticked it reasonably reads a refusal as a bug. Name the input at fault
    // rather than leaving them to reword a prompt that was never the problem.
    const publicTier = Boolean(seedancePersonMediaCaveat(model ? { id: model } : undefined));
    return {
      text: publicTier
        ? "This public model refuses reference media with a recognisable person, whatever you attest. Use a place, an object or a scene as the reference and describe the person in the prompt, or pick a model outside the public tier."
        : "The model's content filter refused this request. Sending it again unchanged will be refused again: change the reference media, or reword the prompt.",
      // Same request, same refusal. The only way through is a different one.
      retryable: false,
      detail,
    };
  }
  if (status === 402) {
    return {
      text: "Not enough credits to finish this render. Top up, then start it again.",
      // Retrying without topping up just spends the same 402 again.
      retryable: false,
      detail,
    };
  }
  // 0 is the client's marker for "no response at all". The request never
  // reached the backend, so nothing was queued and nothing was charged: the
  // most obviously repeatable failure there is.
  if (status === 0) {
    return {
      text: "The request never reached the backend. Check the connection, then start it again.",
      retryable: true,
      detail,
    };
  }
  if (status === 429) {
    return {
      text: "The backend is rate limiting requests right now. Waiting a moment and starting again usually clears it.",
      retryable: true,
      detail,
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      text: "The backend failed while rendering this one. That is usually temporary.",
      retryable: true,
      detail,
    };
  }
  // A 400 is the request itself being refused: the same request will be
  // refused again, so offering a retry would only waste the user's time.
  // `explainConstraintError` handles the ones that name a field.
  if (status === 400) {
    return { text: detail ?? "The backend refused this request.", retryable: false, detail };
  }
  return { text: detail ?? "The render failed.", retryable: false, detail };
}
