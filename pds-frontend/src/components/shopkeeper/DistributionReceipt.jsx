import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, Printer, RefreshCw, ChevronDown } from "lucide-react";
import api from "../../api/axios";
import Button from "../ui/Button";
import Badge from "../ui/Badge";
import Card from "../ui/Card";
import "./DistributionReceipt.css";

// Digital Ration Distribution Receipt. Shown only after the shopkeeper's
// finalize request has returned a committed transaction. It loads the receipt
// from the shop-scoped read endpoint, so the figures on screen are the
// committed database values and not anything the browser computed earlier.

const formatGrams = (value) => `${Number(value).toLocaleString("en-IN")} g`;

const formatSignedGrams = (value) => {
  const grams = Number(value);
  if (grams === 0) return "0 g";
  return `${grams > 0 ? "+" : "−"}${Math.abs(grams).toLocaleString("en-IN")} g`;
};

const formatIssuedAt = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
};

const COMMODITY_LABEL = { rice: "Rice", wheat: "Wheat" };

const CheckMark = () => (
  <svg
    className="dr-check"
    viewBox="0 0 64 64"
    width="72"
    height="72"
    aria-hidden="true"
    focusable="false"
  >
    <circle className="dr-check-circle" cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="3" />
    <path
      className="dr-check-tick"
      d="M20 33 L28 41 L44 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const BlockchainStatus = ({ blockchain, onRefresh, refreshing }) => {
  if (blockchain.status === "recorded") {
    return (
      <p className="text-sm text-text-primary">
        <span className="font-medium">Recorded on Sepolia testnet.</span>{" "}
        <a
          className="break-all font-mono text-xs text-brand-700 underline underline-offset-2"
          href={blockchain.explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {blockchain.txHash}
        </a>
      </p>
    );
  }

  if (blockchain.status === "unavailable") {
    return (
      <p className="text-sm text-text-secondary">
        Blockchain recording could not be completed for this distribution. The
        distribution itself is saved in PDS.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-text-secondary">
        Blockchain recording is still pending. The distribution is already saved.
      </p>
      <Button
        variant="secondary"
        size="sm"
        className="dr-no-print"
        onClick={onRefresh}
        disabled={refreshing}
      >
        <RefreshCw size={14} aria-hidden="true" />
        {refreshing ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
};

const DistributionReceipt = ({ transactionId, onBackToDashboard }) => {
  const [status, setStatus] = useState("loading");
  const [receipt, setReceipt] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped by retry and blockchain refresh to request the receipt again. The
  // fetch itself runs in the effect below, and every state update happens
  // after its await.
  const [attempt, setAttempt] = useState(0);
  // Set by a blockchain refresh: a failed refresh keeps the receipt on screen.
  const silentRetryRef = useRef(false);
  const headingRef = useRef(null);
  const detailsId = useId();

  useEffect(() => {
    if (!transactionId) return undefined;
    const silent = silentRetryRef.current;
    silentRetryRef.current = false;
    let active = true;

    (async () => {
      try {
        const res = await api.get(`/api/shopkeeper/transactions/${transactionId}/receipt`);
        if (!active) return;
        setReceipt(res.data.receipt);
        setErrorMessage("");
        setStatus("ready");
      } catch (error) {
        if (!active) return;
        setErrorMessage(
          error.response?.data?.error ||
            "The distribution was saved, but the receipt could not be loaded.",
        );
        if (!silent) setStatus("error");
      } finally {
        if (active) setRefreshing(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [transactionId, attempt]);

  const retryReceipt = () => {
    setStatus("loading");
    setAttempt((count) => count + 1);
  };

  useEffect(() => {
    if (status === "ready") headingRef.current?.focus();
  }, [status]);

  const handleRefreshBlockchain = () => {
    silentRetryRef.current = true;
    setRefreshing(true);
    setAttempt((count) => count + 1);
  };

  if (!transactionId) {
    return (
      <section className="mx-auto max-w-xl space-y-4 px-4 py-8" role="alert">
        <Card bodyClassName="space-y-4">
          <h2 className="text-lg font-semibold text-text-primary">Receipt not available yet</h2>
          <p className="text-sm text-text-secondary">
            The distribution was saved, but its receipt reference is missing. Please contact your administrator.
          </p>
          <Button variant="secondary" onClick={onBackToDashboard}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back to Shopkeeper Dashboard
          </Button>
        </Card>
      </section>
    );
  }

  if (status === "loading") {
    return (
      <section className="mx-auto max-w-3xl space-y-4 px-4 py-8" aria-live="polite">
        <p className="text-center text-sm text-text-secondary">Loading the receipt…</p>
        <div className="h-64 animate-pulse rounded-md border border-border bg-surface-muted" />
      </section>
    );
  }

  if (status === "error") {
    return (
      <section className="mx-auto max-w-xl space-y-4 px-4 py-8" role="alert">
        <Card bodyClassName="space-y-4">
          <h2 className="text-lg font-semibold text-text-primary">Receipt not available yet</h2>
          <p className="text-sm text-text-secondary">{errorMessage}</p>
          <div className="flex flex-wrap gap-3">
            <Button variant="primary" onClick={retryReceipt}>
              Retry receipt
            </Button>
            <Button variant="secondary" onClick={onBackToDashboard}>
              <ArrowLeft size={16} aria-hidden="true" />
              Back to Shopkeeper Dashboard
            </Button>
          </div>
        </Card>
      </section>
    );
  }

  const { beneficiary, shop, commodities, totals, blockchain } = receipt;
  const allWithinTolerance = commodities.every((row) => row.withinTolerance);

  return (
    <section className="mx-auto max-w-3xl space-y-6 px-4 py-8" aria-labelledby="dr-success-heading">
      <div className="dr-no-print flex flex-col items-center gap-3 text-center">
        <div className="dr-success-icon text-success-text">
          <CheckMark />
        </div>
        <h2
          id="dr-success-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-2xl font-semibold text-text-primary focus:outline-none"
        >
          Distribution Completed Successfully
        </h2>
        <Badge status="success" dot>
          Completed
        </Badge>
      </div>

      <article className="dr-print-root dr-receipt rounded-md border border-border bg-surface shadow-sm" aria-label="Digital Ration Distribution Receipt">
        <header className="space-y-4 border-b border-dashed border-border px-6 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                Public Distribution System
              </p>
              <h3 className="mt-1 text-xl font-semibold text-text-primary">
                Digital Ration Distribution Receipt
              </h3>
            </div>
            <Badge status="success">Status: Completed</Badge>
          </div>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-text-secondary">Receipt reference</dt>
              <dd className="mt-1 break-all font-mono text-xs text-text-primary">{receipt.reference}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Date and time</dt>
              <dd className="mt-1 tabular-nums text-text-primary">{formatIssuedAt(receipt.issuedAt)}</dd>
            </div>
          </dl>
        </header>

        <div className="space-y-6 px-6 py-5">
          <section aria-labelledby="dr-beneficiary-heading" className="space-y-3">
            <h4 id="dr-beneficiary-heading" className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
              Beneficiary
            </h4>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-text-secondary">Name</dt>
                <dd className="mt-0.5 font-medium text-text-primary">{beneficiary.name}</dd>
              </div>
              <div>
                <dt className="text-text-secondary">Ration card</dt>
                <dd className="mt-0.5 font-mono tabular-nums text-text-primary">{beneficiary.maskedCardNumber}</dd>
              </div>
              <div>
                <dt className="text-text-secondary">Category</dt>
                <dd className="mt-0.5 text-text-primary">{beneficiary.category}</dd>
              </div>
              <div>
                <dt className="text-text-secondary">Family size</dt>
                <dd className="mt-0.5 text-text-primary">
                  {beneficiary.familySize ?? "Not recorded"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-text-secondary">Fair Price Shop</dt>
                <dd className="mt-0.5 text-text-primary">
                  {shop.name} <span className="font-mono text-xs text-text-secondary">({shop.code})</span>
                </dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="dr-summary-heading" className="space-y-3">
            <h4 id="dr-summary-heading" className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
              Distribution summary
            </h4>
            <div className="overflow-x-auto">
              <table className="dr-table w-full min-w-[32rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-text-secondary">
                    <th scope="col" className="py-2 pr-3 font-medium">Commodity</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Entitled</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Measured</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Difference</th>
                    <th scope="col" className="py-2 font-medium">Verification</th>
                  </tr>
                </thead>
                <tbody>
                  {commodities.map((row) => (
                    <tr key={row.commodity} className="border-b border-border last:border-0">
                      <th scope="row" className="py-3 pr-3 font-medium text-text-primary">
                        {COMMODITY_LABEL[row.commodity] || row.commodity}
                      </th>
                      <td className="py-3 pr-3 text-right tabular-nums text-text-secondary">{formatGrams(row.entitledGrams)}</td>
                      <td className="py-3 pr-3 text-right tabular-nums font-medium text-text-primary">{formatGrams(row.measuredGrams)}</td>
                      <td className="py-3 pr-3 text-right tabular-nums text-text-secondary">{formatSignedGrams(row.differenceGrams)}</td>
                      <td className="py-3">
                        {row.withinTolerance ? (
                          <Badge status="success" dot>Within ±{row.toleranceGrams} g</Badge>
                        ) : (
                          <Badge status="danger" dot>Outside ±{row.toleranceGrams} g</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="grid gap-3 rounded-sm bg-surface-muted p-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-text-secondary">Total entitled (target)</dt>
                <dd className="mt-0.5 tabular-nums text-text-primary">{formatGrams(totals.entitledGrams)}</dd>
              </div>
              <div>
                <dt className="text-text-secondary">Total distributed (measured)</dt>
                <dd className="mt-0.5 font-semibold tabular-nums text-text-primary">{formatGrams(totals.measuredGrams)}</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="dr-verify-heading" className="space-y-3">
            <h4 id="dr-verify-heading" className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
              Verification
            </h4>
            <p className="text-sm text-text-primary">
              {allWithinTolerance
                ? "Each quantity was measured on the IoT scale and fell within its allowed tolerance."
                : "One or more quantities fell outside the allowed tolerance. Refer this receipt to your administrator."}
            </p>
            <BlockchainStatus blockchain={blockchain} onRefresh={handleRefreshBlockchain} refreshing={refreshing} />
          </section>
        </div>

        <footer className="space-y-1 border-t border-dashed border-border px-6 py-4 text-xs text-text-secondary">
          <p className="font-medium text-text-primary">Please retain this receipt for your records.</p>
          <p>This receipt records the distribution details held by the PDS system.</p>
        </footer>
      </article>

      <div className="dr-no-print space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Button variant="primary" onClick={() => window.print()}>
            <Printer size={16} aria-hidden="true" />
            Download / Print Receipt
          </Button>
          <Button
            variant="secondary"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            <ChevronDown
              size={16}
              aria-hidden="true"
              className={detailsOpen ? "rotate-180 transition-transform" : "transition-transform"}
            />
            View Transaction Details
          </Button>
          <Button variant="secondary" onClick={onBackToDashboard}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back to Shopkeeper Dashboard
          </Button>
        </div>

        {detailsOpen && (
          <div id={detailsId}>
          <Card bodyClassName="space-y-3 text-sm">
            <h3 className="font-semibold text-text-primary">Transaction details</h3>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-text-secondary">Transaction reference</dt>
                <dd className="mt-0.5 break-all font-mono text-xs text-text-primary">{receipt.reference}</dd>
              </div>
              <div>
                <dt className="text-text-secondary">Committed at</dt>
                <dd className="mt-0.5 text-text-primary">{new Date(receipt.issuedAt).toISOString()}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-text-secondary">Blockchain status</dt>
                <dd className="mt-0.5 text-text-primary">{blockchain.status}</dd>
              </div>
            </dl>
          </Card>
          </div>
        )}
      </div>
    </section>
  );
};

export default DistributionReceipt;
