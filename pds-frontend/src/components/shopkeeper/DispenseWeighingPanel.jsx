import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, WifiOff } from 'lucide-react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import api, { resolvedApiBaseUrl } from '../../api/axios';

const TOKEN_KEY = 'pds_token';
const RECONNECT_DELAY_MS = 3000;

const TERMINAL_STATES = [
    'committed',
    'cancelled',
    'device_lost',
    'failed_insufficient_balance',
    'failed_already_claimed',
    'failed_out_of_tolerance',
];

const resolveWsUrl = () => {
    const base = resolvedApiBaseUrl || `${window.location.protocol}//${window.location.hostname}:5055`;
    return `${base.replace(/^http/, 'ws')}/ws/shopkeeper/live`;
};

const COMMODITY_LABEL = { rice: 'rice', wheat: 'wheat' };

const DispenseWeighingPanel = ({
    sessionId,
    commodity,
    entitledGrams,
    toleranceGrams,
    beneficiaryName,
    cardNumber,
    onDone,
}) => {
    const [connected, setConnected] = useState(false);
    const [sessionState, setSessionState] = useState('attached');
    const [gramsInt, setGramsInt] = useState(0);
    const [msLeft, setMsLeft] = useState(null);
    const [cancelling, setCancelling] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [measuredGramsConfirmed, setMeasuredGramsConfirmed] = useState(null);

    const wsRef = useRef(null);
    const reconnectTimerRef = useRef(null);
    const unmountedRef = useRef(false);

    useEffect(() => {
        unmountedRef.current = false;

        const connect = () => {
            const token = localStorage.getItem(TOKEN_KEY);
            const ws = new WebSocket(resolveWsUrl(), token ? [token] : undefined);
            wsRef.current = ws;

            ws.onopen = () => {
                setConnected(true);
                ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
            };

            ws.onmessage = (event) => {
                let payload;
                try {
                    payload = JSON.parse(event.data);
                } catch {
                    return;
                }

                if (payload.type === 'reading') {
                    setGramsInt(payload.gramsInt);
                } else if (payload.type === 'state') {
                    setSessionState(payload.state);
                    if (payload.state === 'confirming' && typeof payload.msLeft === 'number') {
                        setMsLeft(payload.msLeft);
                    } else if (payload.state !== 'confirming') {
                        setMsLeft(null);
                    }
                    // When backend auto-commits or manually confirmed, record the measured grams
                    if (payload.state === 'committed' && typeof payload.measuredGrams === 'number') {
                        setMeasuredGramsConfirmed(payload.measuredGrams);
                    }
                }
            };

            ws.onclose = () => {
                setConnected(false);
                if (!unmountedRef.current && !TERMINAL_STATES.includes(sessionState)) {
                    reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
                }
            };

            ws.onerror = () => ws.close();
        };

        connect();

        return () => {
            unmountedRef.current = true;
            clearTimeout(reconnectTimerRef.current);
            wsRef.current?.close();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

    // Local countdown ticker — the server sends msLeft once when 'confirming'
    // starts; this just counts it down for a smooth in-between display.
    // Deliberately keyed on isConfirming (not msLeft itself) — depending on
    // msLeft would tear down and restart the interval on every tick.
    const isConfirming = sessionState === 'confirming' && msLeft !== null;
    useEffect(() => {
        if (!isConfirming) return undefined;

        const interval = setInterval(() => {
            setMsLeft((prev) => (prev === null ? null : Math.max(0, prev - 250)));
        }, 250);

        return () => clearInterval(interval);
    }, [isConfirming]);

    const handleCancel = async () => {
        setCancelling(true);
        try {
            await api.post(`/api/dispense/session/${sessionId}/cancel`);
        } catch {
            // Session may have already reached a terminal state server-side —
            // the WS 'state' event (or its absence) is the source of truth.
        } finally {
            setCancelling(false);
        }
    };

    const handleConfirm = async () => {
        setConfirming(true);
        try {
            const res = await api.post(`/api/dispense/session/${sessionId}/confirm`);
            // The manual confirm endpoint returns the measured_grams immediately
            if (res.data?.measured_grams !== undefined) {
                setMeasuredGramsConfirmed(res.data.measured_grams);
            }
            // The WS will also send the 'committed' state event, which onDone handles
        } catch (err) {
            // If confirm fails, the session might revert to weighing or reach a failure state
            console.error('Manual confirm failed:', err);
        } finally {
            setConfirming(false);
        }
    };

    const diff = gramsInt - entitledGrams;
    const absDiff = Math.abs(diff);
    const commodityLabel = COMMODITY_LABEL[commodity] || commodity;

    let band = 'red';
    if (absDiff <= toleranceGrams) {
        band = 'green';
    } else if (absDiff <= toleranceGrams * 3) {
        band = 'amber';
    }

    // Status text logic
    let stateText;
    if (!connected) {
        stateText = 'Reconnecting…';
    } else if (sessionState === 'device_lost') {
        stateText = 'Device offline';
    } else if (sessionState === 'cancelled') {
        stateText = 'Cancelled';
    } else if (sessionState === 'committed') {
        stateText = 'Confirmed';
    } else if (sessionState === 'failed_insufficient_balance') {
        stateText = 'Insufficient balance';
    } else if (sessionState === 'failed_already_claimed') {
        stateText = 'Already claimed this month';
    } else if (sessionState === 'failed_out_of_tolerance') {
        stateText = 'Weight outside tolerance';
    } else if (sessionState === 'confirming') {
        stateText = '✓ Weight Stable';
    } else if (gramsInt < 50) {
        stateText = 'Place the container';
    } else if (diff < -toleranceGrams) {
        stateText = `Add ${commodityLabel}`;
    } else if (diff > toleranceGrams) {
        stateText = `Remove ${commodityLabel}`;
    } else {
        stateText = 'Stabilizing...';
    }

    const bandClasses = {
        green: 'border-success-border bg-success-bg text-success-text',
        amber: 'border-warning-border bg-warning-bg text-warning-text',
        red: 'border-danger-border bg-danger-bg text-danger-text',
    };

    const isTerminal = TERMINAL_STATES.includes(sessionState);
    const showOkButton = sessionState === 'confirming' && connected && !confirming;

    return (
        <div className="space-y-4">
            <Card>
                <h2 className="text-lg font-semibold text-text-primary">{beneficiaryName}</h2>
                <p className="mt-1 text-sm text-text-secondary">Card: {cardNumber}</p>
            </Card>

            <Card className={`border-2 ${bandClasses[band]}`} bodyClassName="text-center py-8">
                {sessionState === 'device_lost' && (
                    <WifiOff size={28} className="mx-auto mb-2" aria-hidden="true" />
                )}
                {sessionState === 'confirming' && (
                    <CheckCircle2 size={28} className="mx-auto mb-2 text-success-text" aria-hidden="true" />
                )}
                <p className="text-5xl font-bold tabular-nums">{gramsInt.toLocaleString()} g</p>
                <p className="mt-2 text-sm text-text-secondary">
                    Target: {entitledGrams.toLocaleString()} g &plusmn; {toleranceGrams}g
                </p>
                <p className="mt-4 text-xl font-semibold" role="status" aria-live="polite">
                    {stateText}
                </p>
            </Card>

            <div className="flex gap-3">
                {showOkButton && (
                    <Button
                        variant="primary"
                        className="h-12 flex-1 text-base"
                        onClick={handleConfirm}
                        disabled={confirming}
                    >
                        {confirming ? 'Confirming...' : 'OK'}
                    </Button>
                )}
                <Button
                    variant="danger"
                    className={`h-12 text-base ${showOkButton ? 'flex-1' : 'w-full'}`}
                    onClick={handleCancel}
                    disabled={cancelling || isTerminal}
                >
                    {cancelling ? 'Cancelling…' : 'Cancel'}
                </Button>
            </div>

            <Modal
                isOpen={isTerminal}
                onClose={() => onDone(sessionState, measuredGramsConfirmed)}
                title={stateText}
                footer={
                    <Button variant="primary" onClick={() => onDone(sessionState, measuredGramsConfirmed)}>
                        Done
                    </Button>
                }
            >
                <p className="text-sm text-text-secondary">
                    {sessionState === 'committed' &&
                        `Verified ${measuredGramsConfirmed?.toLocaleString() || entitledGrams.toLocaleString()}g of ${commodityLabel} for ${beneficiaryName}.`}
                    {sessionState === 'cancelled' && 'The dispense was cancelled. Nothing was debited.'}
                    {sessionState === 'device_lost' &&
                        'The weighing scale disconnected — please reconnect it and restart the dispense. Nothing was debited.'}
                    {sessionState === 'failed_insufficient_balance' &&
                        "The beneficiary's wallet no longer holds this commodity's full allocation, so the dispense could not complete. Nothing was debited."}
                    {sessionState === 'failed_already_claimed' &&
                        'This ration card already claimed this commodity for the current month. Nothing was debited.'}
                    {sessionState === 'failed_out_of_tolerance' &&
                        `The final weight was outside the allowed ${toleranceGrams}g tolerance for a ` +
                        `${entitledGrams.toLocaleString()}g allocation. Nothing was debited — re-weigh to try again.`}
                </p>
            </Modal>
        </div>
    );
};

export default DispenseWeighingPanel;
