// eslint-disable-next-line no-unused-vars
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ShopStatusCard from "./ShopStatusCard";
import { MAX_QUEUE_COUNT, parseQueueCount } from "../../lib/queueCount";
import api from "../../api/axios";

vi.mock("../../api/axios", () => ({
  default: { get: vi.fn(), put: vi.fn() },
  resolvedApiBaseUrl: "http://localhost:5055",
}));

const status = (overrides = {}) => ({
  shop_name: "Test Shop",
  availability: { status: "closed", updated_age_seconds: 120 },
  queue: { count: 12, updated_age_seconds: 60, freshness: "current" },
  thresholds: {
    open_status_max_age_seconds: 43200,
    queue_stale_after_seconds: 1800,
    queue_max: MAX_QUEUE_COUNT,
  },
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("parseQueueCount", () => {
  it.each(["0", "1", "12", String(MAX_QUEUE_COUNT), " 7 "])(
    "accepts whole number %j",
    (raw) => {
      expect(parseQueueCount(raw)).toEqual({ value: Number(raw.trim()) });
    },
  );

  it.each([
    ["empty", ""],
    ["blank spaces", "   "],
    ["negative", "-1"],
    ["decimal", "1.5"],
    ["exponent", "1e2"],
    ["letters", "abc"],
    ["over the limit", String(MAX_QUEUE_COUNT + 1)],
  ])("refuses %s", (_label, raw) => {
    expect(parseQueueCount(raw).error).toBeTruthy();
    expect(parseQueueCount(raw).value).toBeUndefined();
  });
});

describe("ShopStatusCard", () => {
  it("shows a loading state, then the stored availability and queue", async () => {
    api.get.mockResolvedValue({ data: { status: status() } });
    render(<ShopStatusCard />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading shop status");
    expect(await screen.findByText("Closed")).toBeInTheDocument();
    expect(screen.getByLabelText(/People waiting/i)).toHaveValue(12);
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/api/shopkeeper/shop-status");
  });

  it("labels a never-reported or stale availability as not reported, not closed", async () => {
    api.get.mockResolvedValue({
      data: { status: status({ availability: { status: "unknown", updated_age_seconds: null } }) },
    });
    render(<ShopStatusCard />);
    expect(await screen.findByText("Status not reported")).toBeInTheDocument();
    expect(screen.queryByText("Closed")).not.toBeInTheDocument();
  });

  it("toggles to open through the API and reflects the server's answer", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: { status: status() } });
    api.put.mockResolvedValue({
      data: { status: status({ availability: { status: "open", updated_age_seconds: 0 } }) },
    });
    render(<ShopStatusCard />);

    await user.click(await screen.findByRole("switch", { name: "Open shop" }));

    expect(api.put).toHaveBeenCalledWith("/api/shopkeeper/shop-status/open", { is_open: true });
    expect(await screen.findByRole("switch", { name: "Close shop" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("shows the server's error when the toggle is refused", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: { status: status() } });
    api.put.mockRejectedValue({ response: { status: 404, data: { error: "No active shop assigned" } } });
    render(<ShopStatusCard />);

    await user.click(await screen.findByRole("switch", { name: "Open shop" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No active shop assigned");
    expect(screen.getByRole("switch", { name: "Open shop" })).toHaveAttribute("aria-checked", "false");
  });

  it("refuses an invalid queue value in the UI, without sending a request", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: { status: status() } });
    render(<ShopStatusCard />);

    const input = await screen.findByLabelText(/People waiting/i);
    await user.clear(input);
    await user.type(input, "1.5");

    expect(screen.getByText("Use a whole number with no decimals or signs.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save count" })).toBeDisabled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("saves a valid queue count and shows the new count as just updated", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: { status: status() } });
    api.put.mockResolvedValue({
      data: { status: status({ queue: { count: 15, updated_age_seconds: 0, freshness: "current" } }) },
    });
    render(<ShopStatusCard />);

    const input = await screen.findByLabelText(/People waiting/i);
    await user.clear(input);
    await user.type(input, "15");
    await user.click(screen.getByRole("button", { name: "Save count" }));

    expect(api.put).toHaveBeenCalledWith("/api/shopkeeper/shop-status/queue", { queue_count: 15 });
    await waitFor(() => expect(screen.getByLabelText(/People waiting/i)).toHaveValue(15));
  });

  it("shows a server validation error and keeps what the shopkeeper typed", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: { status: status() } });
    api.put.mockRejectedValue({ response: { status: 400, data: { error: "Validation failed" } } });
    render(<ShopStatusCard />);

    const input = await screen.findByLabelText(/People waiting/i);
    await user.clear(input);
    await user.type(input, "9");
    await user.click(screen.getByRole("button", { name: "Save count" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Validation failed");
    expect(input).toHaveValue(9);
  });

  it("labels an old queue estimate as last reported, never as live", async () => {
    api.get.mockResolvedValue({
      data: {
        status: status({ queue: { count: 20, updated_age_seconds: 7200, freshness: "last_reported" } }),
      },
    });
    render(<ShopStatusCard />);

    expect(await screen.findByText(/Last reported/)).toBeInTheDocument();
    expect(screen.queryByText(/^Updated/)).not.toBeInTheDocument();
  });

  it("offers a retry on a network failure and recovers when it succeeds", async () => {
    const user = userEvent.setup();
    api.get
      .mockRejectedValueOnce({ message: "Network Error" })
      .mockResolvedValueOnce({ data: { status: status() } });
    render(<ShopStatusCard />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Closed")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("makes exactly one status request on mount (no polling)", async () => {
    api.get.mockResolvedValue({ data: { status: status() } });
    render(<ShopStatusCard />);
    await screen.findByText("Closed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
