// eslint-disable-next-line no-unused-vars
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import ScanAndDispense from "./ScanAndDispense";
import api from "../../api/axios";

vi.mock("../../api/axios", () => ({
  default: { get: vi.fn(), post: vi.fn() },
  resolvedApiBaseUrl: "http://localhost:5055",
}));

vi.mock("../../components/shopkeeper/QRScanner", () => ({
  default: ({ onScan }) => (
    <button
      onClick={() =>
        onScan(
          JSON.stringify({
            rationCardId: "card-123",
            sessionId: "qr-session-456",
            expiresAt: new Date(Date.now() + 120000).toISOString(),
          }),
        )
      }
    >
      Mock Scan QR
    </button>
  ),
}));

vi.mock("../../components/shopkeeper/DispenseWeighingPanel", () => ({
  default: ({ commodity, entitledGrams, onDone }) => (
    <section>
      <h2>Live {commodity} scale</h2>
      <p>Live target: {entitledGrams} g</p>
      <button onClick={() => onDone("captured", entitledGrams - 5)}>
        Finish {commodity}
      </button>
      <button onClick={() => onDone("cancelled", null)}>Cancel weighing</button>
    </section>
  ),
}));

vi.mock("../../components/ui/useToast", () => ({
  default: () => ({ success: vi.fn(), danger: vi.fn(), warning: vi.fn() }),
}));

const beneficiaryData = {
  beneficiary: {
    name: "Test Beneficiary",
    card_number: "CARD123456",
    category: "BPL",
    family_size: 4,
    shop_name: "Test Shop",
    ration_card_id: "card-123",
  },
  wallet: { rice_balance_kg: 3, wheat_balance_kg: 2 },
  allocation: { rice_kg: 3, wheat_kg: 2, rice_grams: 3000, wheat_grams: 2000 },
};

let readingSequence = 0;
const deviceStatus = () => ({
  active: true,
  connectivity: "online",
  current_weight_grams: 0,
  current_weight_at: new Date(Date.now() + ++readingSequence).toISOString(),
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <ScanAndDispense />
    </MemoryRouter>,
  );

const scanBeneficiary = async (user) => {
  renderPage();
  await user.click(screen.getByRole("button", { name: "Mock Scan QR" }));
  await screen.findByText("Test Beneficiary");
};

// The committed receipt, as the backend returns it for transaction tx-final.
const receiptFixture = {
  receipt: {
    reference: "tx-final",
    issuedAt: "2026-10-18T10:00:00.000Z",
    status: "completed",
    shop: { code: "SHOP-1", name: "North Shop" },
    beneficiary: {
      name: "Test Beneficiary",
      maskedCardNumber: "••••••••5678",
      category: "BPL",
      familySize: 3,
    },
    commodities: [
      { commodity: "rice", entitledGrams: 3000, measuredGrams: 2995, differenceGrams: -5, toleranceGrams: 30, withinTolerance: true },
      { commodity: "wheat", entitledGrams: 2000, measuredGrams: 1995, differenceGrams: -5, toleranceGrams: 20, withinTolerance: true },
    ],
    totals: { entitledGrams: 5000, measuredGrams: 4990 },
    blockchain: { status: "pending", txHash: null, explorerUrl: null },
  },
};

const createSessionResponse = (url, body) => {
  if (url === "/api/dispense/session") {
    return Promise.resolve({
      data: {
        session_id: `session-${body.commodity}`,
        session_jwt: "session-token",
        tolerance_grams: body.commodity === "rice" ? 30 : 20,
      },
    });
  }
  if (url.includes("/attach"))
    return Promise.resolve({ data: { state: "attached" } });
  if (url.includes("/capture"))
    return Promise.resolve({ data: { state: "captured" } });
  if (url === "/api/shopkeeper/dispense")
    return Promise.resolve({
      data: {
        message: "Dispensed successfully",
        transaction: { id: "tx-final" },
        dispensed: { rice_qty_kg: 3, wheat_qty_kg: 2 },
      },
    });
  if (url.includes("/cancel"))
    return Promise.resolve({ data: { state: "cancelled" } });
  return Promise.reject(new Error(`Unexpected endpoint ${url}`));
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  readingSequence = 0;
});

describe("Phase 1 shopkeeper measurement flow", () => {
  it("uses the server allocation and attaches an authorized session for the first commodity", async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) =>
      Promise.resolve({
        data:
          url === "/api/shopkeeper/beneficiary/card-123"
            ? beneficiaryData
            : url.startsWith("/api/shopkeeper/transactions/")
            ? receiptFixture
            : deviceStatus(),
      }),
    );
    api.post.mockImplementation(createSessionResponse);

    await scanBeneficiary(user);
    await user.click(
      await screen.findByRole("button", { name: /Start rice weighing/i }),
    );

    expect(await screen.findByText("Live rice scale")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/api/dispense/session", {
      ration_card_id: "card-123",
      commodity: "rice",
      entitled_grams: 3000,
      qr_session_id: "qr-session-456",
    });
    expect(api.post).toHaveBeenCalledWith(
      "/api/dispense/session/session-rice/attach",
      {
        session_jwt: "session-token",
      },
    );
  });

  it("freezes a capture, verifies empty-pan reset, advances to wheat, and finalizes automatically after the last commodity", async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) =>
      Promise.resolve({
        data:
          url === "/api/shopkeeper/beneficiary/card-123"
            ? beneficiaryData
            : url.startsWith("/api/shopkeeper/transactions/")
            ? receiptFixture
            : deviceStatus(),
      }),
    );
    api.post.mockImplementation(createSessionResponse);

    await scanBeneficiary(user);
    await user.click(
      await screen.findByRole("button", { name: /Start rice weighing/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Finish rice" }),
    );

    expect(
      await screen.findByText("Clear and zero the scale"),
    ).toBeInTheDocument();
    expect(screen.getByText("2,995 g")).toBeInTheDocument();

    const startWheat = await screen.findByRole(
      "button",
      { name: /Ready to weigh wheat/i },
      { timeout: 5000 },
    );
    await waitFor(() => expect(startWheat).toBeEnabled(), { timeout: 5000 });
    await user.click(startWheat);
    await user.click(
      await screen.findByRole("button", { name: /Start wheat weighing/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Finish wheat" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Distribution Completed Successfully",
      }),
    ).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith(
      "/api/shopkeeper/dispense",
      expect.objectContaining({
        ration_card_id: "card-123",
        session_id: "qr-session-456",
        rice_session_id: "session-rice",
        wheat_session_id: "session-wheat",
      }),
    );
    expect(api.get).toHaveBeenCalledWith(
      "/api/shopkeeper/transactions/tx-final/receipt",
    );
  });

  it("does not resubmit a refused distribution on its own, and resubmits only when the shopkeeper retries", async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) =>
      Promise.resolve({
        data:
          url === "/api/shopkeeper/beneficiary/card-123"
            ? beneficiaryData
            : url.startsWith("/api/shopkeeper/transactions/")
            ? receiptFixture
            : deviceStatus(),
      }),
    );
    let distributionAttempts = 0;
    api.post.mockImplementation((url, body) => {
      if (url === "/api/shopkeeper/dispense") {
        distributionAttempts += 1;
        if (distributionAttempts === 1) {
          return Promise.reject({
            response: {
              data: { error: "Requested quantity exceeds wallet balance" },
            },
          });
        }
      }
      return createSessionResponse(url, body);
    });

    await scanBeneficiary(user);
    await user.click(
      await screen.findByRole("button", { name: /Start rice weighing/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Finish rice" }),
    );
    const startWheat = await screen.findByRole(
      "button",
      { name: /Ready to weigh wheat/i },
      { timeout: 5000 },
    );
    await waitFor(() => expect(startWheat).toBeEnabled(), { timeout: 5000 });
    await user.click(startWheat);
    await user.click(
      await screen.findByRole("button", { name: /Start wheat weighing/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Finish wheat" }),
    );

    expect(
      await screen.findByText("Requested quantity exceeds wallet balance"),
    ).toBeInTheDocument();
    // Give any automatic resubmission time to fire. None should.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(distributionAttempts).toBe(1);

    await user.click(
      screen.getByRole("button", { name: "Retry Distribution" }),
    );
    await waitFor(() => expect(distributionAttempts).toBe(2));
    expect(
      await screen.findByRole("heading", {
        name: "Distribution Completed Successfully",
      }),
    ).toBeInTheDocument();
  });

  it("does not show a receipt while the distribution request is still pending", async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) =>
      Promise.resolve({
        data:
          url === "/api/shopkeeper/beneficiary/card-123"
            ? beneficiaryData
            : url.startsWith("/api/shopkeeper/transactions/")
            ? receiptFixture
            : deviceStatus(),
      }),
    );
    let resolveDispense;
    api.post.mockImplementation((url, body) => {
      if (url === "/api/shopkeeper/dispense") {
        return new Promise((resolve) => {
          resolveDispense = resolve;
        });
      }
      return createSessionResponse(url, body);
    });

    await scanBeneficiary(user);
    await user.click(
      await screen.findByRole("button", { name: /Start rice weighing/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Finish rice" }),
    );
    const startWheat = await screen.findByRole(
      "button",
      { name: /Ready to weigh wheat/i },
      { timeout: 5000 },
    );
    await waitFor(() => expect(startWheat).toBeEnabled(), { timeout: 5000 });
    await user.click(startWheat);
    await user.click(
      await screen.findByRole("button", { name: /Start wheat weighing/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Finish wheat" }),
    );

    await waitFor(() => expect(resolveDispense).toBeDefined());
    expect(
      screen.queryByRole("heading", { name: "Distribution Completed Successfully" }),
    ).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith(
      expect.stringContaining("/receipt"),
    );

    resolveDispense({
      data: {
        message: "Dispensed successfully",
        transaction: { id: "tx-final" },
        dispensed: { rice_qty_kg: 3, wheat_qty_kg: 2 },
      },
    });
    expect(
      await screen.findByRole("heading", {
        name: "Distribution Completed Successfully",
      }),
    ).toBeInTheDocument();
    expect(
      api.post.mock.calls.filter(([url]) => url === "/api/shopkeeper/dispense"),
    ).toHaveLength(1);
  });

  it("does not advance or mark a commodity complete when its weighing is cancelled", async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) =>
      Promise.resolve({
        data:
          url === "/api/shopkeeper/beneficiary/card-123"
            ? beneficiaryData
            : url.startsWith("/api/shopkeeper/transactions/")
            ? receiptFixture
            : deviceStatus(),
      }),
    );
    api.post.mockImplementation(createSessionResponse);

    await scanBeneficiary(user);
    await user.click(
      await screen.findByRole("button", { name: /Start rice weighing/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Cancel weighing" }),
    );

    expect(
      await screen.findByRole("button", { name: /Start rice weighing/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Clear and zero the scale"),
    ).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/capture$/),
      expect.anything(),
    );
  });
});
