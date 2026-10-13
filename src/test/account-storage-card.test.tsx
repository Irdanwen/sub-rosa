import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountStorageCard } from "../components/settings/AccountStorageCard";
import type { AccountStatus, AccountStorageStatus } from "../lib/account";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const status = { sync_enabled: true } as AccountStatus;
const room = (over: Partial<AccountStorageStatus> = {}): AccountStorageStatus => ({
  used_bytes: 1_400_000_000,
  quota_bytes: 5_368_709_120,
  file_bytes: 1_380_000_000,
  journal_reserve_bytes: 268_435_456,
  measured_at: "2026-10-12T12:00:00Z",
  audio_bytes: 480_000_000,
  studio_bytes: 900_000_000,
  assistant_bytes: 3_000_000,
  largest: [
    { artifact_id: "a", kind: "audio", label: "Weekly meeting", note_id: "n", bytes: 140_000_000 },
    { artifact_id: "b", kind: "studio", label: null, note_id: null, bytes: 60_000_000 },
  ],
  waiting_files: 0,
  files_held: false,
  journal_held: false,
  releasing_chunks: 0,
  compact_ready: true,
  compact_blockers: [],
  compact_pending: 0,
  send_audio: true,
  send_studio: true,
  ...over,
});

beforeEach(() => mocks.invoke.mockReset());

describe("the account's room", () => {
  it("says how much is used, by what, and the largest files", async () => {
    mocks.invoke.mockResolvedValue(room());
    render(<AccountStorageCard status={status} />);
    expect(await screen.findByText("1.3 GB of 5.0 GB used")).toBeInTheDocument();
    expect(
      screen.getByText("Recordings 458 MB, Studio 858 MB, assistant files 3 MB"),
    ).toBeInTheDocument();
    expect(screen.getByText("Weekly meeting")).toBeInTheDocument();
    expect(screen.getByText("Untitled file")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says the account is full, and what waits for room, only when it is", async () => {
    mocks.invoke.mockResolvedValue(
      room({ used_bytes: 5_368_709_000, journal_held: true, files_held: true, waiting_files: 2 }),
    );
    render(<AccountStorageCard status={status} />);
    expect(await screen.findByText(/Your account storage is full/)).toBeInTheDocument();
    expect(screen.getByText("Files waiting for space on this device: 2")).toBeInTheDocument();
  });

  it("warns before the quota is reached", async () => {
    mocks.invoke.mockResolvedValue(room({ used_bytes: 5_000_000_000 }));
    render(<AccountStorageCard status={status} />);
    expect(await screen.findByText(/almost full/)).toBeInTheDocument();
  });

  it("names the devices a smaller form waits for", async () => {
    mocks.invoke.mockResolvedValue(
      room({ compact_ready: false, compact_pending: 13, compact_blockers: ["Mon iPhone Pro"] }),
    );
    render(<AccountStorageCard status={status} />);
    expect(
      await screen.findByText(
        "Files will take less space once every device runs the latest version: Mon iPhone Pro.",
      ),
    ).toBeInTheDocument();
  });

  it("lets this device keep its new recordings to itself", async () => {
    mocks.invoke.mockResolvedValueOnce(room()).mockResolvedValueOnce(room({ send_audio: false }));
    render(<AccountStorageCard status={status} />);
    const box = await screen.findByRole("checkbox", {
      name: "Send this device's recordings to the account",
    });
    await userEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    expect(mocks.invoke).toHaveBeenLastCalledWith("account_storage_set_sending", {
      kind: "audio",
      enabled: false,
    });
  });
});
