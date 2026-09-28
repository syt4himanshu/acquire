import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, CircleCheck, Gauge, WifiOff } from 'lucide-react';
import api from '../../api/axios';
import QRScanner from '../../components/shopkeeper/QRScanner';
import DispenseWeighingPanel from '../../components/shopkeeper/DispenseWeighingPanel';
import useToast from '../../components/ui/useToast';
import Card from '../../components/ui/Card';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Modal from '../../components/ui/Modal';

const FLOW = {
  SCANNING: 'SCANNING',
  BENEFICIARY_LOADED: 'BENEFICIARY_LOADED',
  CONFIRMATION: 'CONFIRMATION',
  WEIGHING: 'WEIGHING',
  SUCCESS: 'SUCCESS',
};

const COMMODITY_BY_QTY_KEY = {
  rice_qty_kg: 'rice',
  wheat_qty_kg: 'wheat',
};

const OUTCOME_TOAST = {
  committed: { type: 'success', message: 'Dispensed successfully via the IoT scale.' },
  cancelled: { type: 'warning', message: 'Weighing cancelled.' },
  device_lost: { type: 'danger', message: 'Weighing scale disconnected — please reconnect and restart.' },
  failed_insufficient_balance: { type: 'danger', message: 'Measured weight exceeded the remaining balance.' },
  failed_already_claimed: {
    type: 'danger',
    message: 'This ration card has already claimed this commodity for the current month.',
  },
  failed_out_of_tolerance: {
    type: 'danger',
    message: 'Final weight was outside the allowed tolerance — nothing was dispensed.',
  },
};

const emptyQuantities = {
  rice_qty_kg: 0,
  wheat_qty_kg: 0,
};

const parseQrPayload = (rawText) => {
  try {
    const parsed = JSON.parse(rawText);

    if (!parsed.rationCardId || !parsed.sessionId || !parsed.expiresAt) {
      return { valid: false, error: 'Invalid QR format' };
    }

    if (Number.isNaN(new Date(parsed.expiresAt).getTime())) {
      return { valid: false, error: 'Invalid QR expiry' };
    }

    if (new Date(parsed.expiresAt) < new Date()) {
      return { valid: false, error: 'QR code has expired' };
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
    return { valid: false, error: 'QR data is not valid JSON' };
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
  const [quantities, setQuantities] = useState(emptyQuantities);
  // The card's authoritative monthly allocation, resolved server-side from its
  // category policy. This is the ONLY source for the dispensed quantity: one
  // allocation is fulfilled by one complete transaction, so the quantity is not
  // something the shopkeeper chooses.
  const [allocation, setAllocation] = useState(null);
  const [dispenseResult, setDispenseResult] = useState(null);
  // The shop's scale, as the backend reports it. `active` is the registry
  // lifecycle ("a device is registered and enabled for this shop") and
  // `connectivity` is whether a bridge is actually connected right now. Kept
  // separate because a registered-but-unplugged scale must read OFFLINE — a row
  // in PostgreSQL is not evidence that anything is on the counter.
  const [deviceStatus, setDeviceStatus] = useState(null);
  const [weighingSession, setWeighingSession] = useState(null);
  const [riceSessionId, setRiceSessionId] = useState(null);
  const [wheatSessionId, setWheatSessionId] = useState(null);
  // Store measured grams from the IoT scale for each commodity
  const [riceMeasuredGrams, setRiceMeasuredGrams] = useState(null);
  const [wheatMeasuredGrams, setWheatMeasuredGrams] = useState(null);

  useEffect(() => {
    let isMounted = true;
    const fetchStatus = async () => {
      try {
        const res = await api.get('/api/dispense/device-status');
        if (isMounted) {
          setDeviceStatus(res.data);
        }
      } catch {
        if (isMounted) {
          setDeviceStatus({ active: false, connectivity: 'offline' });
        }
      }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const maxes = useMemo(
    () => ({
      rice_qty_kg: Number(wallet?.rice_balance_kg || 0),
      wheat_qty_kg: Number(wallet?.wheat_balance_kg || 0),
    }),
    [wallet],
  );

  const hasExceeded = (key) => Number(quantities[key] || 0) > maxes[key];

  const scaleOnline = deviceStatus?.active === true && deviceStatus?.connectivity === 'online';
  const scaleRegistered = deviceStatus?.active === true;

  const bothWeighed = Boolean(riceSessionId && wheatSessionId);

  const resetToScan = () => {
    setFlowState(FLOW.SCANNING);
    setLoading(false);
    setQrPayload(null);
    setBeneficiary(null);
    setWallet(null);
    setQuantities(emptyQuantities);
    setAllocation(null);
    setDispenseResult(null);
    setWeighingSession(null);
    setRiceSessionId(null);
    setWheatSessionId(null);
    setRiceMeasuredGrams(null);
    setWheatMeasuredGrams(null);
  };

  const fetchBeneficiary = async (payload) => {
    setLoading(true);

    try {
      const [beneficiaryRes, deviceStatusRes] = await Promise.all([
        api.get(`/api/shopkeeper/beneficiary/${payload.rationCardId}`, {
          params: { sessionId: payload.sessionId, expiresAt: payload.expiresAt },
        }),
        api
          .get('/api/dispense/device-status')
          .catch(() => ({ data: { active: false, connectivity: 'offline' } })),
      ]);

      const loadedWallet = beneficiaryRes.data.wallet;
      const loadedAllocation = beneficiaryRes.data.allocation || null;

      setBeneficiary(beneficiaryRes.data.beneficiary);
      setWallet(loadedWallet);
      setAllocation(loadedAllocation);

      setQuantities(
        loadedAllocation
          ? { rice_qty_kg: loadedAllocation.rice_kg, wheat_qty_kg: loadedAllocation.wheat_kg }
          : emptyQuantities,
      );
      setDeviceStatus(deviceStatusRes.data);
      setFlowState(FLOW.BENEFICIARY_LOADED);
    } catch (error) {
      toast.danger(error.response?.data?.error || 'Failed to load beneficiary');
      resetToScan();
    } finally {
      setLoading(false);
    }
  };

  const handleWeighOnScale = async (commodity) => {
    const entitledGrams = commodity === 'rice' ? allocation?.rice_grams : allocation?.wheat_grams;

    if (!entitledGrams || entitledGrams <= 0) {
      toast.warning(`No allocation available for ${commodity}`);
      return;
    }

    setLoading(true);
    try {
      const createRes = await api.post('/api/dispense/session', {
        ration_card_id: beneficiary.ration_card_id,
        commodity,
        entitled_grams: entitledGrams,
        qr_session_id: qrPayload.sessionId,
      });

      const { session_id: sessionId, session_jwt: sessionJwt, tolerance_grams: toleranceGrams } = createRes.data;

      await api.post(`/api/dispense/session/${sessionId}/attach`, { session_jwt: sessionJwt });

      setWeighingSession({ sessionId, commodity, entitledGrams, toleranceGrams });
      setFlowState(FLOW.WEIGHING);
    } catch (error) {
      toast.danger(error.response?.data?.error || `Failed to start ${commodity} weighing session`);
    } finally {
      setLoading(false);
    }
  };

  const handleWeighingDone = (outcome, measuredGrams) => {
    if (outcome === 'committed' && weighingSession) {
      if (weighingSession.commodity === 'rice') {
        setRiceSessionId(weighingSession.sessionId);
        setRiceMeasuredGrams(measuredGrams || weighingSession.entitledGrams);
        toast.success('Rice weighing verified! Now proceed to Wheat weighing.');
      } else if (weighingSession.commodity === 'wheat') {
        setWheatSessionId(weighingSession.sessionId);
        setWheatMeasuredGrams(measuredGrams || weighingSession.entitledGrams);
        toast.success('Wheat weighing verified! Ready for final dispense.');
      }
    } else {
      const toastSpec = OUTCOME_TOAST[outcome];
      if (toastSpec) {
        toast[toastSpec.type](toastSpec.message);
      }
    }
    setWeighingSession(null);
    setFlowState(FLOW.BENEFICIARY_LOADED);
  };

  const handleScanResult = (rawText) => {
    const parsed = parseQrPayload(rawText);

    if (!parsed.valid) {
      toast.danger(parsed.error);
      return;
    }

    setQrPayload(parsed.payload);
    fetchBeneficiary(parsed.payload);
  };

  const handleOpenConfirm = () => {
    if (!riceSessionId || !wheatSessionId) {
      toast.warning('Both Rice and Wheat must be weighed and verified on scale first.');
      return;
    }

    if (hasExceeded('rice_qty_kg') || hasExceeded('wheat_qty_kg')) {
      toast.warning('Quantity cannot exceed wallet balance');
      return;
    }

    setFlowState(FLOW.CONFIRMATION);
  };

  const handleDispense = async () => {
    if (!riceSessionId || !wheatSessionId) {
      toast.warning('Both Rice and Wheat must be verified on the IoT scale before final dispense.');
      return;
    }

    setLoading(true);

    try {
      const { data } = await api.post('/api/shopkeeper/dispense', {
        ration_card_id: beneficiary.ration_card_id,
        session_id: qrPayload.sessionId,
        rice_session_id: riceSessionId,
        wheat_session_id: wheatSessionId,
        rice_qty_kg: Number(quantities.rice_qty_kg || 0),
        wheat_qty_kg: Number(quantities.wheat_qty_kg || 0),
      });

      setDispenseResult(data);
      setFlowState(FLOW.SUCCESS);
      toast.success('Dispensed successfully.');
    } catch (error) {
      setFlowState(FLOW.BENEFICIARY_LOADED);
      toast.danger(error.response?.data?.error || 'Dispense failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-primary">Scan &amp; Dispense</h1>
        <button
          type="button"
          onClick={() => navigate('/shopkeeper/dashboard')}
          className="rounded-sm text-sm text-text-secondary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Back
        </button>
      </div>

      {flowState === FLOW.SCANNING && (
        <Card>
          {loading ? (
            <p className="py-10 text-center text-text-secondary">Fetching beneficiary...</p>
          ) : (
            <QRScanner
              onScan={handleScanResult}
              onError={() => toast.danger('Camera access failed. Please allow camera permission.')}
            />
          )}
        </Card>
      )}

      {(flowState === FLOW.BENEFICIARY_LOADED || flowState === FLOW.CONFIRMATION) && beneficiary && wallet && (
        <div className="space-y-4">
          <Card>
            <h2 className="text-lg font-semibold text-text-primary">{beneficiary.name}</h2>
            <p className="mt-1 text-sm text-text-secondary">Card: {beneficiary.card_number}</p>
            <p className="mt-2 text-sm text-text-secondary">Category: {beneficiary.category}</p>
            <p className="text-sm text-text-secondary">Mobile: {beneficiary.mobile || '—'}</p>
            <p className="text-sm text-text-secondary">Family Size: {beneficiary.family_size}</p>
            <p className="text-sm text-text-secondary">Shop: {beneficiary.shop_name}</p>
          </Card>

          {scaleRegistered && (
            <Card bodyClassName="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <Gauge size={16} />
                IoT Scale
              </span>
              {scaleOnline ? (
                <Badge status="success" dot>
                  Online
                </Badge>
              ) : (
                <Badge status="danger" dot icon={<WifiOff size={12} />}>
                  Offline
                </Badge>
              )}
            </Card>
          )}

          <Card bodyClassName="space-y-4">
            <h3 className="font-semibold text-text-primary">Sequential IoT Dispense Workflow</h3>

            <div className="space-y-3">
              {/* Step 1: Rice */}
              <div className="flex items-center justify-between rounded-md border p-3 border-border-default">
                <div className="flex-1">
                  <p className="font-medium text-text-primary">Step 1: Rice Weighing ({quantities.rice_qty_kg} kg)</p>
                  <p className="text-xs text-text-secondary">Target: {allocation?.rice_grams || 0} g</p>
                  {riceSessionId && riceMeasuredGrams !== null && (
                    <p className="text-xs text-success-text font-medium mt-1">
                      ✓ Measured: {riceMeasuredGrams} g
                    </p>
                  )}
                </div>
                {riceSessionId ? (
                  <Badge status="success" icon={<CheckCircle2 size={14} />}>Verified</Badge>
                ) : (
                  <Button
                    variant="primary"
                    className="h-9 text-xs"
                    onClick={() => handleWeighOnScale('rice')}
                    disabled={loading || !scaleOnline || hasExceeded('rice_qty_kg')}
                  >
                    <Gauge size={14} className="mr-1 inline" />
                    Weigh Rice
                  </Button>
                )}
              </div>

              {/* Step 2: Wheat */}
              <div className="flex items-center justify-between rounded-md border p-3 border-border-default">
                <div className="flex-1">
                  <p className="font-medium text-text-primary">Step 2: Wheat Weighing ({quantities.wheat_qty_kg} kg)</p>
                  <p className="text-xs text-text-secondary">Target: {allocation?.wheat_grams || 0} g</p>
                  {wheatSessionId && wheatMeasuredGrams !== null && (
                    <p className="text-xs text-success-text font-medium mt-1">
                      ✓ Measured: {wheatMeasuredGrams} g
                    </p>
                  )}
                </div>
                {wheatSessionId ? (
                  <Badge status="success" icon={<CheckCircle2 size={14} />}>Verified</Badge>
                ) : (
                  <Button
                    variant="primary"
                    className="h-9 text-xs"
                    onClick={() => handleWeighOnScale('wheat')}
                    disabled={loading || !scaleOnline || !riceSessionId || hasExceeded('wheat_qty_kg')}
                    title={!riceSessionId ? 'Complete Rice weighing first' : undefined}
                  >
                    <Gauge size={14} className="mr-1 inline" />
                    Weigh Wheat
                  </Button>
                )}
              </div>
            </div>

            {bothWeighed && (
              <Card className="border-success-border bg-success-bg/10">
                <h4 className="text-sm font-semibold text-text-primary mb-3">Transaction Summary</h4>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Rice:</span>
                    <span className="font-medium text-text-primary">{riceMeasuredGrams} g</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Wheat:</span>
                    <span className="font-medium text-text-primary">{wheatMeasuredGrams} g</span>
                  </div>
                </div>
              </Card>
            )}

            <div className="flex flex-col gap-3 sm:flex-row pt-2">
              <Button
                variant="primary"
                className="h-11 flex-1"
                onClick={handleOpenConfirm}
                disabled={!bothWeighed}
              >
                Complete Transaction
              </Button>
              <Button variant="secondary" className="h-11 flex-1" onClick={resetToScan}>
                Scan Again
              </Button>
            </div>
          </Card>
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

      {flowState === FLOW.SUCCESS && dispenseResult && (
        <Modal
          isOpen={true}
          onClose={resetToScan}
          title=""
          className="max-w-lg"
        >
          <div className="text-center">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-success-bg border-2 border-success-border">
              <CircleCheck size={48} className="text-success-text" />
            </div>
            <h2 className="mt-4 text-2xl font-bold text-text-primary">Transaction Completed</h2>

            <div className="mt-6 space-y-4 text-left">
              <div className="rounded-md border border-border-default bg-surface-muted p-4">
                <p className="text-sm font-semibold text-text-primary mb-2">Beneficiary</p>
                <p className="text-base font-medium text-text-primary">{beneficiary.name}</p>
                <p className="text-sm text-text-secondary">Card: {beneficiary.card_number}</p>
              </div>

              <div className="rounded-md border border-border-default bg-surface-muted p-4">
                <p className="text-sm font-semibold text-text-primary mb-3">Dispensed Quantities</p>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-text-secondary">Rice:</span>
                    <span className="text-base font-semibold text-text-primary">
                      {riceMeasuredGrams} g ({dispenseResult.dispensed.rice_qty_kg} kg)
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-text-secondary">Wheat:</span>
                    <span className="text-base font-semibold text-text-primary">
                      {wheatMeasuredGrams} g ({dispenseResult.dispensed.wheat_qty_kg} kg)
                    </span>
                  </div>
                </div>
              </div>

              <div className="rounded-md border border-border-default bg-surface-muted p-4">
                <p className="text-sm font-semibold text-text-primary mb-2">Transaction Details</p>
                <p className="text-xs text-text-secondary break-all">
                  ID: {dispenseResult.transaction.id}
                </p>
                <p className="text-xs text-text-secondary mt-1">
                  Entitlement successfully deducted.
                </p>
                <p className="text-xs text-text-secondary">
                  Blockchain: Anchoring initiated
                </p>
              </div>
            </div>

            <Button variant="primary" className="mt-6 w-full h-11" onClick={resetToScan}>
              Scan Next Beneficiary
            </Button>
          </div>
        </Modal>
      )}

      <Modal
        isOpen={flowState === FLOW.CONFIRMATION}
        onClose={() => setFlowState(FLOW.BENEFICIARY_LOADED)}
        title="Confirm Transaction"
        footer={
          <>
            <Button variant="secondary" onClick={() => setFlowState(FLOW.BENEFICIARY_LOADED)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleDispense} disabled={loading}>
              {loading ? 'Processing...' : 'Confirm & Complete'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">Beneficiary: <span className="font-medium text-text-primary">{beneficiary?.name}</span></p>
          <div className="rounded-md border border-border-default bg-surface-muted p-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Rice (IoT Verified):</span>
              <span className="font-medium text-text-primary">{riceMeasuredGrams} g ({quantities.rice_qty_kg} kg)</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Wheat (IoT Verified):</span>
              <span className="font-medium text-text-primary">{wheatMeasuredGrams} g ({quantities.wheat_qty_kg} kg)</span>
            </div>
          </div>
          <p className="text-xs text-text-secondary">This will deduct the entitlement from the beneficiary's wallet and record the transaction.</p>
        </div>
      </Modal>
    </div>
  );
};

export default ScanAndDispense;
