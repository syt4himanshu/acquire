// eslint-disable-next-line no-unused-vars
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Dashboard from "./Dashboard";
import api from "../../api/axios";

vi.mock("../../api/axios", () => ({
  default: { get: vi.fn() },
}));

const shopResponse = {
  shop: { name: "North Market PDS", code: "DL-042", area: "Ward 8" },
  shopkeeper: {
    name: "Asha Kumar",
    email: "asha@example.test",
    mobile: "9876543210",
  },
  today_transactions: 12,
};

const renderDashboard = () =>
  render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Shopkeeper dashboard", () => {
  it("shows shop details, API transaction count, and connected device state", async () => {
    api.get.mockImplementation((url) =>
      Promise.resolve({
        data:
          url === "/api/shopkeeper/me"
            ? shopResponse
            : {
                active: true,
                connectivity: "online",
                device_name: "Counter scale",
              },
      }),
    );

    renderDashboard();

    expect(
      await screen.findByRole("heading", { name: "North Market PDS" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Code DL-042/)).toBeInTheDocument();
    expect(screen.getByText("Ward 8")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Dispense Ration/i }),
    ).toBeInTheDocument();
  });

  it("keeps device connectivity unknown when its status request fails", async () => {
    api.get.mockImplementation((url) =>
      url === "/api/shopkeeper/me"
        ? Promise.resolve({ data: shopResponse })
        : Promise.reject(new Error("network unavailable")),
    );

    renderDashboard();

    expect(await screen.findByText("Status unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Offline")).not.toBeInTheDocument();
  });
});
