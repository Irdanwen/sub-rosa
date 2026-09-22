import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TopUp } from "../../website/src/pages/account";

describe("the account site's Top up tab", () => {
  it("says what happens, then sends to Carpe Diem's deposit page", () => {
    render(<TopUp />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    const deposit = screen.getByRole("link", { name: /Carpe Diem/ });
    expect(deposit).toHaveAttribute("href", "https://carpe-diem.xyz/dashboard/buyer");
    expect(deposit).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByRole("link", { name: /Sub Rosa/ })).toHaveAttribute("href", "subrosa://");
  });
});
