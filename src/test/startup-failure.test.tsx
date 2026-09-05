import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { StartupFailure } from "../components/brand/StartupFailure";

it("keeps startup recoverable when the retry itself rejects", async () => {
  const retry = vi
    .fn()
    .mockRejectedValueOnce(new Error("Still unavailable"))
    .mockResolvedValueOnce(undefined);
  render(<StartupFailure message="Initial failure" onRetry={retry} />);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Still unavailable"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled());
  expect(retry).toHaveBeenCalledTimes(2);
});
