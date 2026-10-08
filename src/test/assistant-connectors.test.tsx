// A custom assistant's "Connectors" permission (ADR-0092 addendum), and the
// desktop approval of a connector tool, which never offers "Always".

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { AssistantConnectors } from "../components/connectors/AssistantConnectors";
import { isConnectorApproval } from "../lib/agent-chat-runtime";
import { type AssistantTool, connectorIdOf, connectorPermission } from "../lib/assistants";

const CONNECTORS = [
  { id: "linear", name: "Linear" },
  { id: "notion", name: "Notion" },
].map((connector) => ({
  ...connector,
  url: "",
  catalogId: connector.id,
  auth: "oauth",
  enabled: true,
  toolPolicy: {},
  status: "connected",
  lastError: null,
  signedIn: true,
  tools: [],
  toolsFetchedAt: null,
}));

describe("an assistant's connectors", () => {
  it("are connector:<id> entries beside its other tools", () => {
    expect(connectorPermission("linear")).toBe("connector:linear");
    expect(connectorIdOf("connector:linear")).toBe("linear");
    expect(connectorIdOf("web")).toBeNull();
  });

  it("are ticked one by one, and nothing else in the tools changes", async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "connector_list" ? CONNECTORS : { servers: [], builtins: [] },
    );
    const onChange = vi.fn();
    const tools: AssistantTool[] = ["web", "connector:notion"];
    render(<AssistantConnectors tools={tools} onChange={onChange} />);
    const linear = (await screen.findByRole("checkbox", { name: /Linear/ })) as HTMLInputElement;
    const notion = screen.getByRole("checkbox", { name: /Notion/ }) as HTMLInputElement;
    expect(linear.checked).toBe(false);
    expect(notion.checked).toBe(true);
    fireEvent.click(linear);
    expect(onChange).toHaveBeenLastCalledWith(["web", "connector:notion", "connector:linear"]);
    fireEvent.click(notion);
    expect(onChange).toHaveBeenLastCalledWith(["web"]);
  });

  it("point to Settings when the account has none", async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "connector_list" ? [] : { servers: [], builtins: [] },
    );
    render(<AssistantConnectors tools={[]} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Add a connector in Settings/)).toBeTruthy());
  });
});

describe("a connector approval on the computer", () => {
  it("is recognised by the label the runtime gives a plugin rule", () => {
    expect(
      isConnectorApproval("<mcp__subrosa_connectors__linear__create_issue> (plugin approval rule)"),
    ).toBe(true);
    expect(isConnectorApproval("rm -rf build")).toBe(false);
    expect(isConnectorApproval(undefined)).toBe(false);
  });
});
