import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Gauge, WifiOff } from "lucide-react";
import api from "../../api/axios";
import QRScanner from "../../components/shopkeeper/QRScanner";
import DispenseWeighingPanel from "../../components/shopkeeper/DispenseWeighingPanel";
import DistributionReceipt from "../../components/shopkeeper/DistributionReceipt";
import useToast from "../../components/ui/useToast";
import Card from "../../components/ui/Card";
import Button from "../../components/ui/Button";
import Badge from "../../components/ui/Badge";

const FLOW = {
  SCANNING: "SCANNING",
  BENEFICIARY_LOADED: "BENEFICIARY_LOADED",
  WEIGHING: "WEIGHING",
  REVIEW: "REVIEW",
};

const ZERO_RESET_TOLERANCE_GRAMS = 15;
const ZERO_RESET_REQUIRED_READINGS = 3;
const READING_STALE_AFTER_MS = 3000;

const OUTCOME_TOAST = {
  captured: { type: "success", message: "Measurement captured and frozen." },
  cancelled: { type: "warning", message: "Weighing cancelled." },
  device_lost: {
    type: "danger",
    message: "Weighing scale disconnected — please reconnect and restart.",
  },
  failed_insufficient_balance: {
    type: "danger",
    message: "Measured weight exceeded the remaining balance.",
  },
  failed_already_claimed: {
    type: "danger",
    message:
      "This ration card has already claimed this commodity for the current month.",
  },
  failed_out_of_tolerance: {
    type: "danger",
    message: "Weight was outside the allowed tolerance.",
  },
};

const parseQrPayload = (rawText) => {
  try {
    const parsed = JSON.parse(rawText);

    if (!parsed.rationCardId || !parsed.sessionId || !parsed.expiresAt) {
      return { valid: false, error: "Invalid QR format" };
    }

    if (Number.isNaN(new Date(parsed.expiresAt).getTime())) {
      return { valid: false, error: "Invalid QR expiry" };
    }

    if (new Date(parsed.expiresAt) < new Date()) {
      return { valid: false, error: "QR code has expired" };
    }

    return {
      valid: true,
      payload: {
        rationCardId: parsed.rationCardId,
        sessionId: parsed.sessionId,
        expiresAt: parsed.expiresAt,
      },
    };
  } catch {
    return { valid: false, error: "QR data is not valid JSON" };
  }
};

const ScanAndDispense = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const [flowState, setFlowState] = useState(FLOW.SCANNING);
  const [loading, setLoading] = useState(false);
  const [qrPayload, setQrPayload] = useState(null);
  const [beneficiary, setBeneficiary] = useState(null);
  const [wallet, setWallet] = useState(null);
  // The card's authoritative monthly allocation, resolved server-side from its
  // category policy. This is the ONLY source for the dispensed quantity: one
  // allocation is fulfilled by one complete transaction, so the quantity is not
  // something the shopkeeper chooses.
  const [allocation, setAllocation] = useState(null);
  // The shop's scale, as the backend reports it. `active` is the registry
  // lifecycle ("a device is registered and enabled for this shop") and
  // `connectivity` is whether a bridge is actually connected right now. Kept
  // separate because a registered-but-unplugged scale must read OFFLINE — a row
  // in PostgreSQL is not evidence that anything is on the counter.
  const [deviceStatus, setDeviceStatus] = useState(null);
  const [weighingSession, setWeighingSession] = useState(null);
  const [completedMeasurements, setCompletedMeasurements] = useState({});
  const [isFinalizingDistribution, setIsFinalizingDistribution] =
    useState(false);
  const [distributionResult, setDistributionResult] = useState(null);
  // Set when finalize fails. The effect below stays idle until the shopkeeper
  // asks to retry, so a persistent refusal is not resubmitted in a loop.
  const [finalizeError, setFinalizeError] = useState("");
  const [tareRequired, setTareRequired] = useState(false);
  const [zeroReadings, setZeroReadings] = useState([]);
  const activeSessionIdRef = useRef(null);
  const tareRequiredRef = useRef(false);
  // True from the moment a finalize request is sent until it settles. Stops a
  // second request while the first is in flight, even before React re-renders.
  const finalizeInFlightRef = useRef(false);

  useEffect(
    () => () => {
      const sessionId = activeSessionIdRef.current;
      if (sessionId)
        api.post(`/api/dispense/session/${sessionId}/cancel`).catch(() => {});
    },
    [],
  );

  useEffect(() => {
    let isMounted = true;
    const fetchStatus = async () => {
      try {
        const res = await api.get("/api/dispense/device-status");
        if (isMounted) {
          const receivedAt = Date.now();
          setDeviceStatus({ ...res.data, receivedAt });
          const readingAt = new Date(res.data.current_weight_at).getTime();
          const readingAgeMs = receivedAt - readingAt;
          if (
            tareRequiredRef.current &&
            Number.isFinite(res.data.current_weight_grams) &&
            readingAgeMs <= READING_STALE_AFTER_MS &&
            readingAgeMs >= -READING_STALE_AFTER_MS
          ) {
            setZeroReadings((previous) => {
              if (previous.some((reading) => reading.takenAt === readingAt))
                return previous;
              return [
                ...previous,
                {
                  grams: Number(res.data.current_weight_grams),
                  takenAt: readingAt,
                },
              ].slice(-ZERO_RESET_REQUIRED_READINGS);
            });
          }
        }
      } catch {
        if (isMounted) {
          setDeviceStatus(null);
        }
      }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 1000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const scaleOnline =
    deviceStatus?.active === true && deviceStatus?.connectivity === "online";
  const requiredCommodities = useMemo(
    () => [
      ...(Number(allocation?.rice_grams) > 0 ? ["rice"] : []),
      ...(Number(allocation?.wheat_grams) > 0 ? ["wheat"] : []),
    ],
    [allocation],
  );
  const remainingCommodities = requiredCommodities.filter(
    (commodity) => !completedMeasurements[commodity],
  );
  const activeCommodity = remainingCommodities[0] || null;
  const isZeroReadingFresh = Boolean(
    deviceStatus?.current_weight_at &&
      Math.abs(
        deviceStatus.receivedAt -
          new Date(deviceStatus.current_weight_at).getTime(),
      ) <= READING_STALE_AFTER_MS,
  );
  const isPanResetVerified =
    zeroReadings.length >= ZERO_RESET_REQUIRED_READINGS &&
    zeroReadings.every(
      (reading) => Math.abs(reading.grams) <= ZERO_RESET_TOLERANCE_GRAMS,
    ) &&
    Math.max(...zeroReadings.map((reading) => reading.grams)) -
      Math.min(...zeroReadings.map((reading) => reading.grams)) <=
      ZERO_RESET_TOLERANCE_GRAMS;

  const resetToScan = () => {
    setFlowState(FLOW.SCANNING);
    setLoading(false);
    setQrPayload(null);
    setBeneficiary(null);
    setWallet(null);
    setAllocation(null);
    if (activeSessionIdRef.current) {
      api
        .post(`/api/dispense/session/${activeSessionIdRef.current}/cancel`)
        .catch(() => {});
      activeSessionIdRef.current = null;
    }
    setWeighingSession(null);
    setCompletedMeasurements({});
    setDistributionResult(null);
    setFinalizeError("");
    tareRequiredRef.current = false;
    setTareRequired(false);
    setZeroReadings([]);
  };

  const fetchBeneficiary = async (payload) => {
    setLoading(true);

    try {
      const [beneficiaryRes, deviceStatusRes] = await Promise.all([
        api.get(`/api/shopkeeper/beneficiary/${payload.rationCardId}`, {
          params: {
            sessionId: payload.sessionId,
            expiresAt: payload.expiresAt,
          },
        }),
        api.get("/api/dispense/device-status").catch(() => ({ data: null })),
      ]);

      const loadedWallet = beneficiaryRes.data.wallet;
      const loadedAllocation = beneficiaryRes.data.allocation || null;

      setBeneficiary(beneficiaryRes.data.beneficiary);
      setWallet(loadedWallet);
      setAllocation(loadedAllocation);

      setDeviceStatus(deviceStatusRes.data);
      setFlowState(FLOW.BENEFICIARY_LOADED);
    } catch (error) {
      toast.danger(error.response?.data?.error || "Failed to load beneficiary");
      resetToScan();
    } finally {
      setLoading(false);
    }
  };

  const handleWeighOnScale = async (commodity) => {
    const entitledGrams = allocation?.[`${commodity}_grams`];

    if (!entitledGrams || entitledGrams <= 0) {
      toast.warning(`No allocation available for ${commodity}`);
      return;
    }

    setLoading(true);
    try {
      const createRes = await api.post("/api/dispense/session", {
        ration_card_id: beneficiary.ration_card_id,
        commodity,
        entitled_grams: entitledGrams,
        qr_session_id: qrPayload.sessionId,
      });

      const {
        session_id: sessionId,
        session_jwt: sessionJwt,
        tolerance_grams: toleranceGrams,
      } = createRes.data;

      await api.post(`/api/dispense/session/${sessionId}/attach`, {
        session_jwt: sessionJwt,
      });

      setWeighingSession({
        sessionId,
        commodity,
        entitledGrams,
        toleranceGrams,
      });
      activeSessionIdRef.current = sessionId;
      setFlowState(FLOW.WEIGHING);
    } catch (error) {
      toast.danger(
        error.response?.data?.error ||
          `Failed to start ${commodity} weighing session`,
      );
    } finally {
      setLoading(false);
    }
  };

  const handleWeighingDone = (outcome, measuredGrams) => {
    let nextFlowState = FLOW.BENEFICIARY_LOADED;
    if (
      outcome === "captured" &&
      weighingSession &&
      Number.isFinite(measuredGrams)
    ) {
      setCompletedMeasurements((previous) => ({
        ...previous,
        [weighingSession.commodity]: {
          measuredGrams,
          entitledGrams: weighingSession.entitledGrams,
          toleranceGrams: weighingSession.toleranceGrams,
          sessionId: weighingSession.sessionId,
        },
      }));
      activeSessionIdRef.current = null;
      const stillRequired = requiredCommodities.filter(
        (commodity) =>
          commodity !== weighingSession.commodity &&
          !completedMeasurements[commodity],
      );
      if (stillRequired.length) {
        tareRequiredRef.current = true;
        setTareRequired(true);
        setZeroReadings([]);
      } else {
        nextFlowState = FLOW.REVIEW;
      }
    } else {
      const toastSpec = OUTCOME_TOAST[outcome];
      if (toastSpec) toast[toastSpec.type](toastSpec.message);
      if (outcome !== "captured") activeSessionIdRef.current = null;
    }
    setWeighingSession(null);
    setFlowState(nextFlowState);
  };

  const handleBeginNextCommodity = () => {
    if (!isPanResetVerified || !scaleOnline) return;
    tareRequiredRef.current = false;
    setTareRequired(false);
    setZeroReadings([]);
  };

  useEffect(() => {
    if (
      flowState !== FLOW.REVIEW ||
      !beneficiary ||
      !qrPayload ||
      isFinalizingDistribution ||
      distributionResult ||
      finalizeError ||
      requiredCommodities.length === 0
    ) {
      return;
    }

    const hasAllMeasurements = requiredCommodities.every((commodity) =>
      Boolean(completedMeasurements[commodity]),
    );

    if (!hasAllMeasurements) {
      return;
    }

    const finalizeDistribution = async () => {
      if (finalizeInFlightRef.current) return;
      finalizeInFlightRef.current = true;
      setIsFinalizingDistribution(true);
      try {
        const payload = {
          ration_card_id: beneficiary.ration_card_id,
          session_id: qrPayload.sessionId,
          rice_session_id: completedMeasurements.rice?.sessionId || null,
          wheat_session_id: completedMeasurements.wheat?.sessionId || null,
        };

        const response = await api.post("/api/shopkeeper/dispense", payload);
        setDistributionResult(response.data);
        toast.success(
          response.data?.message || "Distribution completed successfully.",
        );
      } catch (error) {
        const message =
          error.response?.data?.error ||
          "Distribution could not be completed. Please retry.";
        setFinalizeError(message);
        toast.danger(message);
      } finally {
        finalizeInFlightRef.current = false;
        setIsFinalizingDistribution(false);
      }
    };

    finalizeDistribution();
  }, [
    beneficiary,
    completedMeasurements,
    distributionResult,
    finalizeError,
    flowState,
    isFinalizingDistribution,
    qrPayload,
    requiredCommodities,
    toast,
  ]);

  const handleScanResult = (rawText) => {
    const parsed = parseQrPayload(rawText);

    if (!parsed.valid) {
      toast.danger(parsed.error);
      return;
    }

    setQrPayload(parsed.payload);
    fetchBeneficiary(parsed.payload);
  };

  // The receipt replaces the workflow only once finalize has returned a
  // committed transaction (distributionResult is set in the success path only).
  if (distributionResult) {
    return (
      <DistributionReceipt
        transactionId={distributionResult.transaction?.id}
        onBackToDashboard={() => navigate("/shopkeeper/dashboard")}
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-primary">
          Scan &amp; Dispense
        </h1>
        <button
          type="button"
          onClick={() => navigate("/shopkeeper/dashboard")}
          className="rounded-sm text-sm text-text-secondary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Back
        </button>
      </div>

      {flowState === FLOW.SCANNING && (
        <Card>
          {loading ? (
            <p className="py-10 text-center text-text-secondary">
              Fetching beneficiary...
            </p>
          ) : (
            <QRScanner
              onScan={handleScanResult}
              onError={() =>
                toast.danger(
                  "Camera access failed. Please allow camera permission.",
                )
              }
            />
          )}
        </Card>
      )}

      {flowState !== FLOW.SCANNING && beneficiary && wallet && (
        <div className="space-y-4">
          <Card>
            <h2 className="text-lg font-semibold text-text-primary">
              {beneficiary.name}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              Card: {beneficiary.card_number}
            </p>
            <p className="mt-2 text-sm text-text-secondary">
              Category: {beneficiary.category}
            </p>
            <p className="text-sm text-text-secondary">
              Mobile: {beneficiary.mobile || "—"}
            </p>
            <p className="text-sm text-text-secondary">
              Family Size: {beneficiary.family_size}
            </p>
            <p className="text-sm text-text-secondary">
              Shop: {beneficiary.shop_name}
            </p>
          </Card>

          <Card bodyClassName="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Gauge size={16} />
              IoT Scale
            </span>
            {scaleOnline ? (
              <Badge status="success" dot>
                Online
              </Badge>
            ) : deviceStatus?.active ? (
              <Badge status="warning" dot icon={<WifiOff size={12} />}>
                Offline
              </Badge>
            ) : (
              <Badge status="neutral" dot>
                {deviceStatus ? "No active scale" : "Status unavailable"}
              </Badge>
            )}
          </Card>

          <Card bodyClassName="space-y-4">
            <h3 className="font-semibold text-text-primary">
              Entitlement and available balance
            </h3>
            <div className="grid grid-cols-3 gap-2 border-b border-border pb-2 text-xs font-medium text-text-secondary">
              <span>Commodity</span>
              <span>This month</span>
              <span>Available</span>
            </div>
            {[
              ["Rice", allocation?.rice_kg, wallet.rice_balance_kg],
              ["Wheat", allocation?.wheat_kg, wallet.wheat_balance_kg],
            ].map(([commodity, entitled, available]) => (
              <div key={commodity} className="grid grid-cols-3 gap-2 text-sm">
                <span className="font-medium text-text-primary">
                  {commodity}
                </span>
                <span className="tabular-nums text-text-secondary">
                  {Number(entitled || 0).toLocaleString()} kg
                </span>
                <span className="tabular-nums text-text-secondary">
                  {Number(available || 0).toLocaleString()} kg
                </span>
              </div>
            ))}
          </Card>

          {flowState === FLOW.BENEFICIARY_LOADED &&
            activeCommodity &&
            !tareRequired && (
              <Card bodyClassName="space-y-4">
                <div>
                  <p className="text-xs font-semibold uppercase text-text-secondary">
                    Commodity {Object.keys(completedMeasurements).length + 1} of{" "}
                    {requiredCommodities.length}
                  </p>
                  <h3 className="mt-1 text-lg font-semibold capitalize text-text-primary">
                    {activeCommodity} weighing
                  </h3>
                  <p className="mt-1 text-sm text-text-secondary">
                    Target:{" "}
                    {Number(
                      allocation?.[`${activeCommodity}_grams`] || 0,
                    ).toLocaleString()}{" "}
                    g
                  </p>
                </div>
                <Button
                  variant="primary"
                  className="h-11 w-full"
                  onClick={() => handleWeighOnScale(activeCommodity)}
                  disabled={loading || !scaleOnline}
                >
                  <Gauge size={16} />
                  {loading
                    ? "Starting scale..."
                    : `Start ${activeCommodity} weighing`}
                </Button>
              </Card>
            )}

          {flowState === FLOW.BENEFICIARY_LOADED &&
            tareRequired &&
            activeCommodity && (
              <Card bodyClassName="space-y-4">
                <div>
                  <h3 className="font-semibold text-text-primary">
                    Clear and zero the scale
                  </h3>
                  <p className="mt-1 text-sm text-text-secondary">
                    Remove all grain and any container from the platform. The
                    next commodity stays locked until the connected scale
                    reports three fresh, steady readings within 15 g of zero.
                  </p>
                </div>
                <div className="flex items-center justify-between rounded-sm border border-border bg-surface-muted px-4 py-3">
                  <span className="text-sm text-text-secondary">
                    Current empty-pan reading
                  </span>
                  <span className="font-semibold tabular-nums text-text-primary">
                    {isZeroReadingFresh &&
                    Number.isFinite(deviceStatus?.current_weight_grams)
                      ? `${deviceStatus.current_weight_grams} g`
                      : "Waiting for scale"}
                  </span>
                </div>
                <p role="status" className="text-sm text-text-secondary">
                  {!scaleOnline
                    ? "Scale disconnected; reconnect to continue."
                    : isPanResetVerified
                    ? `Scale reset verified. Ready for ${activeCommodity}.`
                    : `${zeroReadings.length} of ${ZERO_RESET_REQUIRED_READINGS} fresh zero readings verified.`}
                </p>
                <Button
                  variant="primary"
                  className="h-11 w-full"
                  onClick={handleBeginNextCommodity}
                  disabled={!scaleOnline || !isPanResetVerified}
                >
                  Ready to weigh {activeCommodity}
                </Button>
              </Card>
            )}

          {(flowState === FLOW.REVIEW ||
            Object.keys(completedMeasurements).length > 0) && (
            <Card bodyClassName="space-y-4">
              <h3 className="font-semibold text-text-primary">
                Measurement review
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-left text-sm">
                  <thead className="border-b border-border text-xs text-text-secondary">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Commodity</th>
                      <th className="py-2 pr-3 font-medium">Target</th>
                      <th className="py-2 pr-3 font-medium">Measured</th>
                      <th className="py-2 font-medium">Validation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requiredCommodities.map((commodity) => {
                      const measurement = completedMeasurements[commodity];
                      return (
                        <tr
                          key={commodity}
                          className="border-b border-border last:border-0"
                        >
                          <th
                            scope="row"
                            className="py-3 pr-3 font-medium capitalize text-text-primary"
                          >
                            {commodity}
                          </th>
                          <td className="py-3 pr-3 tabular-nums text-text-secondary">
                            {measurement
                              ? `${measurement.entitledGrams.toLocaleString()} g`
                              : "Pending"}
                          </td>
                          <td className="py-3 pr-3 tabular-nums text-text-secondary">
                            {measurement
                              ? `${measurement.measuredGrams.toLocaleString()} g`
                              : "Pending"}
                          </td>
                          <td className="py-3">
                            {measurement ? (
                              <Badge status="success" dot>
                                Within ±{measurement.toleranceGrams} g
                              </Badge>
                            ) : (
                              <Badge status="neutral">Not weighed</Badge>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {flowState === FLOW.REVIEW && (
                <div className="space-y-3 border-t border-border pt-4">
                  <Button
                    variant="primary"
                    className="h-11 w-full"
                    disabled={isFinalizingDistribution}
                    onClick={
                      finalizeError && !distributionResult
                        ? () => setFinalizeError("")
                        : undefined
                    }
                  >
                    {isFinalizingDistribution
                      ? "Completing Distribution..."
                      : distributionResult
                      ? "Distribution complete"
                      : finalizeError
                      ? "Retry Distribution"
                      : "Complete Distribution"}
                  </Button>
                  <p
                    className="text-center text-xs text-text-secondary"
                    role={finalizeError ? "alert" : undefined}
                  >
                    {isFinalizingDistribution
                      ? "Finalizing the weighted transaction and updating the wallet."
                      : distributionResult
                      ? "The full allocation has been committed and the transaction is recorded."
                      : finalizeError
                      ? finalizeError
                      : "Finalizing the completed measurements now uses the canonical transaction flow."}
                  </p>
                </div>
              )}
              <Button
                variant="secondary"
                className="w-full"
                onClick={resetToScan}
              >
                Cancel measurement workflow
              </Button>
            </Card>
          )}
        </div>
      )}

      {flowState === FLOW.WEIGHING && weighingSession && beneficiary && (
        <DispenseWeighingPanel
          sessionId={weighingSession.sessionId}
          commodity={weighingSession.commodity}
          entitledGrams={weighingSession.entitledGrams}
          toleranceGrams={weighingSession.toleranceGrams}
          beneficiaryName={beneficiary.name}
          cardNumber={beneficiary.card_number}
          onDone={handleWeighingDone}
        />
      )}
    </div>
  );
};

export default ScanAndDispense;
