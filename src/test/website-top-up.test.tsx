import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TopUp } from "../../website/src/pages/account";

describe("the account site's Top up tab", () => {
  it("sends to Carpe Diem's card payment page first", () => {
    render(<TopUp />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    const pay = screen.getByRole("link", { name: /Pay by card on Carpe Diem/ });
    expect(pay).toHaveAttribute("href", "https://carpe-diem.xyz/pay");
    expect(pay).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByRole("link", { name: /Back to Sub Rosa/ })).toHaveAttribute(
      "href",
      "subrosa://",
    );
  });

  it("keeps the USDC deposit for a key that belongs to a wallet", () => {
    render(<TopUp />);
    expect(screen.getByRole("link", { name: /Deposit USDC instead/ })).toHaveAttribute(
      "href",
      "https://carpe-diem.xyz/dashboard/buyer",
    );
  });
});
