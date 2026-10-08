// Connectors (ADR-0092): the cards a connector call leaves under a reply, the
// one catalog every shell shares, and GitHub's device sign-in.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  convertFileSrc: () => "subrosa-app://localhost/",
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { ConnectorCallCard } from "../components/chat-blocks/ConnectorCallCard";
import { ConnectorsPanel } from "../components/connectors/ConnectorsPanel";
import { parseChatBlock } from "../lib/chat-blocks";
import {
  type Connector,
  type ConnectorCall,
  type ConnectorCatalog,
  triggerKindsFor,
} from "../lib/connectors";

const CALL_ID = "0b7c1d2e-1111-4222-8333-444455556666";

const CATALOG: ConnectorCatalog = {
  servers: [
    {
      id: "linear",
      name: "Linear",
      url: "https://mcp.linear.app/mcp",
      description: "Find, create and update issues and projects",
      auth: "oauth",
    },
  ],
  builtins: [
    {
      id: "google",
      name: "Google",
      available: false,
      description: "",
      gated: [{ id: "gmail", name: "Gmail", state: "requires_verification" }],
    },
    { id: "microsoft", name: "Microsoft", available: true, description: "", gated: [] },
  ],
};

function connector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    catalogId: "linear",
    auth: "oauth",
    enabled: true,
    toolPolicy: {},
    status: "connected",
    lastError: null,
    signedIn: true,
    tools: [
      {
        name: "create_issue",
        title: "Create issue",
        description: "Creates an issue.",
        readOnly: false,
        rule: "ask",
        chosen: false,
        interactive: false,
      },
    ],
    toolsFetchedAt: null,
    ...overrides,
  };
}

function call(overrides: Partial<ConnectorCall> = {}): ConnectorCall {
  return {
    id: CALL_ID,
    taskId: "task",
    connectorId: "linear",
    connectorName: "Linear",
    tool: "create_issue",
    toolTitle: null,
    arguments: { title: "Fix the login" },
    status: "pending",
    result: null,
    error: null,
    createdAt: "2026-10-08T07:00:00Z",
    appId: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.invoke.mockReset();
});

describe("the connector blocks", () => {
  it("name a row by id and nothing looser", () => {
    expect(parseChatBlock("subrosa:connector", JSON.stringify({ v: 1, callId: CALL_ID }))).toEqual({
      kind: "connector",
      callId: CALL_ID,
    });
    expect(
      parseChatBlock("subrosa:app", JSON.stringify({ v: 1, appId: `call-${CALL_ID}` })),
    ).toEqual({ kind: "app", appId: `call-${CALL_ID}` });
    for (const [info, body] of [
      ["subrosa:connector", { v: 1, callId: "../etc" }],
      ["subrosa:app", { v: 1, appId: CALL_ID }],
      ["subrosa:app", { v: 1, appId: "call-x" }],
      ["subrosa:connector", { v: 2, callId: CALL_ID }],
    ] as const) {
      expect(parseChatBlock(info, JSON.stringify(body))).toBeNull();
    }
  });
});

describe("a connector call card", () => {
  it("shows what an ask will send and runs it only on Approve", async () => {
    mocks.invoke.mockImplementation(async (command: string, args: { approve?: boolean }) => {
      if (command === "connector_call_get") return call();
      if (command === "connector_call_decide") {
        expect(args.approve).toBe(true);
        return call({
          status: "done",
          result: {
            text: "Created LIN-7",
            links: [{ title: "LIN-7", url: "https://linear.app/x/7" }],
            isError: false,
          },
        });
      }
      return undefined;
    });
    render(<ConnectorCallCard block={{ kind: "connector", callId: CALL_ID }} />);
    expect(await screen.findByText(/Waiting for your approval/)).toBeTruthy();
    expect(screen.getByText(/Fix the login/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Created LIN-7")).toBeTruthy();
    expect(screen.getByRole("button", { name: /LIN-7/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("says so when it was declined", async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "connector_call_get" ? call({ status: "denied" }) : undefined,
    );
    render(<ConnectorCallCard block={{ kind: "connector", callId: CALL_ID }} />);
    expect(await screen.findByText("Declined. Nothing ran.")).toBeTruthy();
  });
});

describe("the connectors panel", () => {
  it("offers the catalog, says what Google cannot do yet, and connects in one tap", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "connector_add") return connector({ signedIn: false, tools: [] });
      if (command === "connector_sign_in")
        return { authUrl: "https://linear.app/oauth", connected: false, device: null };
      return undefined;
    });
    const refresh = vi.fn();
    render(<ConnectorsPanel connectors={[]} catalog={CATALOG} refresh={refresh} />);
    expect(screen.getByText(/Gmail: requires verification/)).toBeTruthy();
    expect(screen.getByText("Not available in this build")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Connect" }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("connector_sign_in", { id: "linear" }),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("connector_add", {
      request: { catalogId: "linear" },
    });
    expect(await screen.findByText(/Finish signing in in your browser/)).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("connects the same way on every shell, without a second sign-in for the agent", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "connector_add") return connector({ signedIn: false });
      if (command === "connector_sign_in")
        return { authUrl: "https://linear.app/oauth", connected: false, device: null };
      return undefined;
    });
    render(<ConnectorsPanel connectors={[]} catalog={CATALOG} refresh={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Connect" }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("connector_sign_in", { id: "linear" }),
    );
    // Nothing is written into the agent runtime's own MCP list any more.
    expect(mocks.invoke).not.toHaveBeenCalledWith("hermes_mcp_oauth_login", expect.anything());
  });

  it("shows GitHub's device code until the sign-in lands", async () => {
    const github = {
      id: "github" as const,
      name: "GitHub",
      available: true,
      description: "",
      gated: [],
    };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "connector_add")
        return connector({ id: "github", name: "GitHub", auth: "github", signedIn: false });
      if (command === "connector_sign_in")
        return {
          authUrl: "https://github.com/login/device",
          connected: false,
          device: {
            userCode: "WDJB-MJHT",
            verificationUri: "https://github.com/login/device",
            expiresIn: 900,
          },
        };
      return undefined;
    });
    const catalog = { ...CATALOG, builtins: [...CATALOG.builtins, github] };
    const { rerender } = render(
      <ConnectorsPanel connectors={[]} catalog={catalog} refresh={vi.fn()} />,
    );
    expect(screen.getByText(/Repositories, issues and pull requests/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Connect" })[1] as HTMLElement);
    expect(await screen.findByText("WDJB-MJHT")).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("connector_add", {
      request: { catalogId: "github" },
    });
    // Once GitHub is signed in, the code goes away by itself.
    rerender(
      <ConnectorsPanel
        connectors={[connector({ id: "github", name: "GitHub", auth: "github" })]}
        catalog={catalog}
        refresh={vi.fn()}
      />,
    );
    expect(screen.queryByText("WDJB-MJHT")).toBeNull();
  });

  it("tells the shell when a connector is removed", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const onRemoved = vi.fn(async () => undefined);
    render(
      <ConnectorsPanel
        connectors={[connector()]}
        catalog={CATALOG}
        refresh={vi.fn()}
        onRemoved={onRemoved}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(onRemoved).toHaveBeenCalledWith(expect.objectContaining({ id: "linear" })),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("connector_remove", { id: "linear" });
    expect(await screen.findByText("Linear removed.")).toBeTruthy();
  });

  it("lets each tool be allowed, asked about or turned off", async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "connector_set_tool_policy" ? connector() : undefined,
    );
    render(<ConnectorsPanel connectors={[connector()]} catalog={CATALOG} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    const rule = screen.getByRole("combobox", { name: "Rule for Create issue" });
    expect((rule as HTMLSelectElement).value).toBe("ask");
    fireEvent.change(rule, { target: { value: "deny" } });
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("connector_set_tool_policy", {
        id: "linear",
        tool: "create_issue",
        rule: "deny",
      }),
    );
  });

  it("shows the custom connector form only in developer mode", async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "connector_add" ? connector({ id: "mine-abc", auth: "none" }) : undefined,
    );
    window.localStorage.removeItem("os-june:connectors-developer-mode");
    render(<ConnectorsPanel connectors={[]} catalog={CATALOG} refresh={vi.fn()} />);
    expect(screen.queryByRole("form", { name: "Add custom connector" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Developer mode" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Server address" }), {
      target: { value: "https://mcp.example.com/mcp" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "How it signs in" }), {
      target: { value: "none" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("connector_add", {
        request: { name: "", url: "https://mcp.example.com/mcp", auth: "none" },
      }),
    );
    window.localStorage.removeItem("os-june:connectors-developer-mode");
  });
});

describe("trigger kinds", () => {
  it("follow what each connector can watch", () => {
    expect(triggerKindsFor({ auth: "google" })).toEqual(["calendar_event"]);
    expect(triggerKindsFor({ auth: "microsoft" })).toEqual(["calendar_event", "email_match"]);
    expect(triggerKindsFor({ auth: "oauth" })).toEqual(["tool_poll", "resource_updated"]);
  });
});
