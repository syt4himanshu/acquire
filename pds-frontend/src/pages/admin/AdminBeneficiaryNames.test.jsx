// eslint-disable-next-line no-unused-vars
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import RationCards from "./RationCards";
import Beneficiaries from "./Beneficiaries";
import api from "../../api/axios";

vi.mock("../../api/axios", () => ({
  default: { get: vi.fn(), post: vi.fn() },
  resolvedApiBaseUrl: "http://localhost:5055",
}));

vi.mock("../../components/ui/useToast", () => ({
  default: () => ({ success: vi.fn(), danger: vi.fn(), warning: vi.fn() }),
}));

const rationCardRows = [
  {
    id: "rc-1",
    card_number: "PDS-REAL-1",
    category: "BPL",
    head_name: "Sunita Pawar",
    shop_name: "Shop One",
    area_name: "Area One",
    family_size: 3,
    rice_balance_kg: 2,
    wheat_balance_kg: 1,
    created_at: "2026-07-25T10:00:00Z",
  },
  {
    id: "rc-2",
    card_number: "PDS-NOHEAD-2",
    category: "APL",
    head_name: null,
    shop_name: "Shop Two",
    area_name: "Area Two",
    family_size: 0,
    rice_balance_kg: 0,
    wheat_balance_kg: 0,
    created_at: "2026-07-24T10:00:00Z",
  },
];

const beneficiaryRows = [
  {
    name: "Sunita Pawar",
    mobile: "9604686258",
    card_number: "PDS-REAL-1",
    category: "BPL",
    shop_name: "Shop One",
    area_name: "Area One",
    family_size: 3,
  },
  {
    name: null,
    mobile: null,
    card_number: "PDS-NOHEAD-2",
    category: "APL",
    shop_name: "Shop Two",
    area_name: "Area Two",
    family_size: 0,
  },
];

const pagination = { page: 1, limit: 20, total: 2, total_pages: 1 };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Admin Ration Cards page — head names", () => {
  it("shows the real head name from the API, not a placeholder", async () => {
    api.get.mockResolvedValue({ data: { data: rationCardRows, pagination } });
    render(
      <MemoryRouter>
        <RationCards />
      </MemoryRouter>,
    );

    const row = (await screen.findByText("PDS-REAL-1")).closest("tr");
    expect(within(row).getByText("Sunita Pawar")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/api/admin/ration-cards");
  });

  it("shows 'Name unavailable' for a card with no head, rather than a blank or dash", async () => {
    api.get.mockResolvedValue({ data: { data: rationCardRows, pagination } });
    render(
      <MemoryRouter>
        <RationCards />
      </MemoryRouter>,
    );

    const row = (await screen.findByText("PDS-NOHEAD-2")).closest("tr");
    expect(within(row).getByText("Name unavailable")).toBeInTheDocument();
    expect(within(row).queryByText("—")).not.toBeInTheDocument();
  });
});

describe("Admin Beneficiaries page — names and mobiles", () => {
  it("shows each beneficiary's real name and mobile from the API", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/api/admin/beneficiaries") return Promise.resolve({ data: { data: beneficiaryRows, pagination } });
      return Promise.resolve({ data: { areas: [], shops: [] } });
    });
    render(
      <MemoryRouter>
        <Beneficiaries />
      </MemoryRouter>,
    );

    const row = (await screen.findByText("PDS-REAL-1")).closest("tr");
    expect(within(row).getByText("Sunita Pawar")).toBeInTheDocument();
    expect(within(row).getByText("9604686258")).toBeInTheDocument();
  });

  it("shows 'Name unavailable' and a dash for a card whose head record is missing", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/api/admin/beneficiaries") return Promise.resolve({ data: { data: beneficiaryRows, pagination } });
      return Promise.resolve({ data: { areas: [], shops: [] } });
    });
    render(
      <MemoryRouter>
        <Beneficiaries />
      </MemoryRouter>,
    );

    const row = (await screen.findByText("PDS-NOHEAD-2")).closest("tr");
    expect(within(row).getByText("Name unavailable")).toBeInTheDocument();
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(within(row).getByText("Shop Two")).toBeInTheDocument();
  });
});
