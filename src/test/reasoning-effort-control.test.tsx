// The desktop effort menu sits in the composer box, which clips what
// overflows its rounded surface: the menu must be drawn outside it.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReasoningEffortControl } from "../components/agent/ChatTurnControls";
import type { VeniceModelDto } from "../lib/tauri";

const model = {
  provider: "venice",
  id: "thinker",
  name: "Thinker",
  modelType: "text",
  traits: [],
  capabilities: ["supportsFunctionCalling", "supportsReasoningEffort"],
} as VeniceModelDto;

describe("the reasoning effort menu", () => {
  it("opens outside the clipping composer box, and a choice closes it", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <div className="agent-composer-box" style={{ overflow: "hidden" }}>
        <ReasoningEffortControl model={model} onChange={onChange} />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: /^Reasoning effort/ }));
    const menu = screen.getByRole("menu");
    expect(menu.closest(".agent-composer-box")).toBeNull();
    expect(menu.style.position).toBe("fixed");

    await user.click(screen.getByRole("menuitemradio", { name: "High effort" }));
    expect(onChange).toHaveBeenCalledWith("thinker");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
