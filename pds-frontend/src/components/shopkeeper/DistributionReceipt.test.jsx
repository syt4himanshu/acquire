// eslint-disable-next-line no-unused-vars
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import DistributionReceipt from "./DistributionReceipt";
import api from "../../api/axios";

vi.mock("../../api/axios", () => ({
  default: { get: vi.fn() },
}));

const TX_ID = "11111111-2222-4333-8444-555555555555";
const TX_HASH = `0x${"ab".repeat(32)}`;

const receiptFixture = (overrides = {}) => ({
  reference: TX_ID,
  issuedAt: "2026-10-18T10:00:00.000Z",
  status: "completed",
  shop: { code: "SHOP-1", name: "North Shop" },
  beneficiary: {
    name: "Asha Devi",
    maskedCardNumber: "••••••••5678",
    category: "BPL",
    familySize: 3,
  },
  commodities: [
    { commodity: "rice", entitledGrams: 3000, measuredGrams: 2994, differenceGrams: -6, toleranceGrams: 30, withinTolerance: true },
    { commodity: "wheat", entitledGrams: 2000, measuredGrams: 2010, differenceGrams: 10, toleranceGrams: 20, withinTolerance: true },
  ],
  totals: { entitledGrams: 5000, measuredGrams: 5004 },
  blockchain: { status: "pending", txHash: null, explorerUrl: null },
  ...overrides,
});

const okResponse = (receipt) => Promise.resolve({ data: { receipt } });

const renderReceipt = (props = {}) => {
  const onBackToDashboard = vi.fn();
  const utils = render(
    <DistributionReceipt
      transactionId={TX_ID}
      onBackToDashboard={onBackToDashboard}
      {...props}
    />,
  );
  return { ...utils, onBackToDashboard };
};

beforeEach(() => {
  api.get.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DistributionReceipt", () => {
  it("loads the committed receipt for the transaction id and shows its heading", async () => {
    api.get.mockImplementation(() => okResponse(receiptFixture()));
    renderReceipt();

    expect(
      await screen.findByRole("heading", { name: "Distribution Completed Successfully" }),
    ).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(`/api/shopkeeper/transactions/${TX_ID}/receipt`);
    expect(screen.getByText("Digital Ration Distribution Receipt")).toBeInTheDocument();
  });

  it("shows the beneficiary, masked card, shop and receipt reference from the response", async () => {
    api.get.mockImplementation(() => okResponse(receiptFixture()));
    renderReceipt();

    await screen.findByText("Asha Devi");
    expect(screen.getByText("••••••••5678")).toBeInTheDocument();
    expect(screen.getByText("BPL")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText(/North Shop/)).toBeInTheDocument();
    expect(screen.getByText(/\(SHOP-1\)/)).toBeInTheDocument();
    expect(screen.getByText(TX_ID)).toBeInTheDocument();
  });

  it("separates entitlement from measured quantity and shows the correct difference and total", async () => {
    api.get.mockImplementation(() => okResponse(receiptFixture()));
    renderReceipt();

    const rice = await screen.findByRole("rowheader", { name: "Rice" });
    const riceRow = rice.closest("tr");
    expect(riceRow).toHaveTextContent("3,000 g");
    expect(riceRow).toHaveTextContent("2,994 g");
    expect(riceRow).toHaveTextContent("−6 g");
    expect(riceRow).toHaveTextContent("Within ±30 g");

    const wheat = screen.getByRole("rowheader", { name: "Wheat" }).closest("tr");
    expect(wheat).toHaveTextContent("+10 g");
    expect(wheat).toHaveTextContent("Within ±20 g");

    expect(screen.getByText("Total entitled (target)")).toBeInTheDocument();
    expect(screen.getByText("5,000 g")).toBeInTheDocument();
    expect(screen.getByText("Total distributed (measured)")).toBeInTheDocument();
    expect(screen.getByText("5,004 g")).toBeInTheDocument();
  });

  it("flags a quantity outside its tolerance and does not claim a clean verification", async () => {
    api.get.mockImplementation(() =>
      okResponse(
        receiptFixture({
          commodities: [
            { commodity: "rice", entitledGrams: 3000, measuredGrams: 2950, differenceGrams: -50, toleranceGrams: 30, withinTolerance: false },
          ],
          totals: { entitledGrams: 3000, measuredGrams: 2950 },
        }),
      ),
    );
    renderReceipt();

    expect(await screen.findByText("Outside ±30 g")).toBeInTheDocument();
    expect(
      screen.getByText(/One or more quantities fell outside the allowed tolerance/),
    ).toBeInTheDocument();
  });

  it("links a recorded blockchain hash to Sepolia Etherscan in a new tab with safe rel", async () => {
    api.get.mockImplementation(() =>
      okResponse(
        receiptFixture({
          blockchain: {
            status: "recorded",
            txHash: TX_HASH,
            explorerUrl: `https://sepolia.etherscan.io/tx/${TX_HASH}`,
          },
        }),
      ),
    );
    renderReceipt();

    const link = await screen.findByRole("link", { name: TX_HASH });
    expect(link).toHaveAttribute("href", `https://sepolia.etherscan.io/tx/${TX_HASH}`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
    expect(link.getAttribute("rel")).toMatch(/noreferrer/);
  });

  it("shows the blockchain record as pending, without a link, when no hash exists yet", async () => {
    api.get.mockImplementation(() => okResponse(receiptFixture()));
    renderReceipt();

    expect(
      await screen.findByText(/Blockchain recording is still pending/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("refreshes the blockchain status on demand and shows the hash once it arrives", async () => {
    const user = userEvent.setup();
    api.get
      .mockResolvedValueOnce({ data: { receipt: receiptFixture() } })
      .mockResolvedValueOnce({
        data: {
          receipt: receiptFixture({
            blockchain: {
              status: "recorded",
              txHash: TX_HASH,
              explorerUrl: `https://sepolia.etherscan.io/tx/${TX_HASH}`,
            },
          }),
        },
      });
    renderReceipt();

    await user.click(await screen.findByRole("button", { name: "Check again" }));

    expect(await screen.findByRole("link", { name: TX_HASH })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("shows the anchoring as unavailable, not pending, when recording has failed", async () => {
    api.get.mockImplementation(() =>
      okResponse(receiptFixture({ blockchain: { status: "unavailable", txHash: null, explorerUrl: null } })),
    );
    renderReceipt();

    expect(
      await screen.findByText(/Blockchain recording could not be completed/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/still pending/)).not.toBeInTheDocument();
  });

  it("shows an error state, not a receipt, when the receipt request fails, and retries on demand", async () => {
    const user = userEvent.setup();
    api.get
      .mockRejectedValueOnce({ response: { data: { error: "Network down" } } })
      .mockResolvedValueOnce({ data: { receipt: receiptFixture() } });
    renderReceipt();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Network down");
    expect(screen.queryByText("Digital Ration Distribution Receipt")).not.toBeInTheDocument();
    expect(screen.queryByText("Asha Devi")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry receipt" }));

    expect(
      await screen.findByRole("heading", { name: "Distribution Completed Successfully" }),
    ).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("uses a safe default message when the failure carries no server text", async () => {
    api.get.mockRejectedValue(new Error("socket hang up"));
    renderReceipt();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The distribution was saved, but the receipt could not be loaded.",
    );
  });

  it("does not call the API and shows a clear error when no transaction reference is available", async () => {
    renderReceipt({ transactionId: undefined });

    expect(await screen.findByRole("alert")).toHaveTextContent(/receipt reference is missing/);
    expect(api.get).not.toHaveBeenCalled();
  });

  it("returns to the dashboard from the Back action", async () => {
    const user = userEvent.setup();
    api.get.mockImplementation(() => okResponse(receiptFixture()));
    const { onBackToDashboard } = renderReceipt();

    await user.click(await screen.findByRole("button", { name: "Back to Shopkeeper Dashboard" }));

    expect(onBackToDashboard).toHaveBeenCalledTimes(1);
  });

  it("opens the print dialog from the Download / Print action", async () => {
    const user = userEvent.setup();
    const printSpy = vi.fn();
    vi.stubGlobal("print", printSpy);
    api.get.mockImplementation(() => okResponse(receiptFixture()));
    renderReceipt();

    await user.click(await screen.findByRole("button", { name: /Download \/ Print Receipt/ }));

    expect(printSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("reveals transaction details from the disclosure button, controlled by aria-expanded", async () => {
    const user = userEvent.setup();
    api.get.mockImplementation(() => okResponse(receiptFixture()));
    renderReceipt();

    const toggle = await screen.findByRole("button", { name: "View Transaction Details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { name: "Transaction details" })).toBeInTheDocument();
  });

  it("never shows a full ration card number", async () => {
    api.get.mockImplementation(() => okResponse(receiptFixture()));
    const { container } = renderReceipt();
    await screen.findByText("Asha Devi");

    // The receipt reference is the only long digit run allowed; it is removed
    // first so the check looks at everything else on the page.
    const visibleText = container.textContent.split(TX_ID).join("");
    expect(visibleText).not.toMatch(/\d{8,}/);
    expect(visibleText).toContain("••••••••5678");
  });

  it("has no accessibility violations in the loaded receipt", async () => {
    api.get.mockImplementation(() => okResponse(receiptFixture()));
    const { container } = renderReceipt();
    await waitFor(() => expect(screen.getByText("Asha Devi")).toBeInTheDocument());

    expect(await axe(container)).toHaveNoViolations();
  });
});
