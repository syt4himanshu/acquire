import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, RefreshControl, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import api from "../api/axios";
import { useAuth } from "../context/AuthContext";
import FpsStatusCard from "../components/FpsStatusCard";
import { colors, typography, spacing, radius } from "../theme";
import {
    Card,
    Button,
    Badge,
    ScreenHeader,
    SkeletonCard,
    Icon,
    Avatar,
    ProgressBar,
    EmptyState,
    useToast,
} from "../components/primitives";

// ASSUMPTION: the API only returns the *remaining* balance per grain
// (wallet.*_balance_kg), not a monthly entitlement total, so "% used" can't
// be derived from the response alone. Mocked here using the largest per-card
// allocation any category receives (AAY: 4 kg rice / 3 kg wheat — see
// policies.rice_per_card_grams and src/config/allocation.js on the backend),
// so the progress bar has a realistic denominator. Allocation is per card,
// not per person, so a single flat figure is now the correct shape for this
// placeholder. Flagging for follow-up: the API should expose the card's
// actual per-category entitlement total.
const MOCK_MONTHLY_ENTITLEMENT_KG = { rice: 4, wheat: 3 };

// The FPS status is polled, not pushed: the only shop-level live channel is the
// shopkeeper's own socket, and beneficiaries have no socket. A 30 s poll is
// enough for an Open/Closed flag and a queue estimate.
const FPS_POLL_INTERVAL_MS = 30000;

export default function DashboardScreen({ navigation }) {
    const { logout } = useAuth();
    const toast = useToast();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [fps, setFps] = useState({ snapshot: null, fetchedAtMs: null, failed: false });
    const [clockMs, setClockMs] = useState(() => Date.now());

    // Separate from fetchAll so a failing FPS request cannot break the wallet
    // and transaction data. A 401 is left to fetchAll, which logs out.
    useEffect(() => {
        let active = true;
        const loadFps = async () => {
            try {
                const res = await api.get("/api/beneficiary/fps-status");
                if (active) setFps({ snapshot: res.data.status, fetchedAtMs: Date.now(), failed: false });
            } catch (err) {
                if (active && err.response?.status !== 401) {
                    setFps((prev) => ({ ...prev, failed: true }));
                }
            }
        };
        loadFps();
        const timer = setInterval(() => {
            setClockMs(Date.now());
            loadFps();
        }, FPS_POLL_INTERVAL_MS);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, []);

    const fetchAll = useCallback(async () => {
        try {
            const [meRes, walletRes, familyRes, txRes] = await Promise.all([
                api.get("/api/beneficiary/me"),
                api.get("/api/beneficiary/wallet"),
                api.get("/api/beneficiary/family"),
                api.get("/api/beneficiary/transactions?limit=5"),
            ]);
            setData({
                beneficiary: meRes.data.beneficiary,
                wallet: walletRes.data.wallet,
                family: familyRes.data.family,
                transactions: txRes.data.transactions,
            });
        } catch (err) {
            if (err.response?.status === 401) {
                logout();
            } else {
                toast.show("Failed to load data. Pull to refresh.", { variant: "error" });
            }
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [logout, toast]);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    const onRefresh = () => { setRefreshing(true); fetchAll(); };

    const handleLogout = () => {
        // The one deliberately-kept native dialog: logging out is
        // destructive to the current session and irreversible from this
        // screen, so a system confirm is more appropriate than a toast.
        Alert.alert("Logout", "Are you sure you want to log out?", [
            { text: "Cancel", style: "cancel" },
            { text: "Logout", style: "destructive", onPress: logout },
        ]);
    };

    if (loading) {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.padding}>
                    <SkeletonCard height={90} />
                    <SkeletonCard height={120} />
                    <SkeletonCard height={100} />
                    <SkeletonCard height={160} />
                </View>
            </SafeAreaView>
        );
    }

    const { beneficiary, wallet, family, transactions } = data || {};
    const catColor = colors.category[beneficiary?.category?.toLowerCase()] || colors.textSecondary;

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
                showsVerticalScrollIndicator={false}
            >
                {/* Header */}
                <ScreenHeader align="flex-start" style={styles.header}>
                    <View>
                        <View style={styles.greetingRow}>
                            <Icon name="greeting" size={typography.size.xs} color={colors.onPrimary} />
                            <Text style={styles.greeting}>Welcome back</Text>
                        </View>
                        <Text style={styles.name}>{beneficiary?.head_name}</Text>
                        <Text style={styles.cardNum}>Card: {beneficiary?.card_number}</Text>
                    </View>
                    <Badge
                        label={beneficiary?.category}
                        color={catColor}
                        accessibilityLabel={`Ration card category: ${beneficiary?.category}`}
                    />
                </ScreenHeader>

                {/* Wallet */}
                <Card title="Monthly Wallet" icon="wallet" style={styles.card}>
                    <View style={styles.grainRow}>
                        <GrainItem
                            label="Rice"
                            icon="grainRice"
                            value={wallet?.rice_balance_kg}
                            entitlement={MOCK_MONTHLY_ENTITLEMENT_KG.rice}
                            unit="kg"
                            color={colors.grain.rice}
                        />
                        <GrainItem
                            label="Wheat"
                            icon="grainWheat"
                            value={wallet?.wheat_balance_kg}
                            entitlement={MOCK_MONTHLY_ENTITLEMENT_KG.wheat}
                            unit="kg"
                            color={colors.grain.wheat}
                        />
                    </View>
                </Card>

                {/* FPS status */}
                <FpsStatusCard
                    snapshot={fps.snapshot}
                    fetchedAtMs={fps.fetchedAtMs}
                    nowMs={clockMs}
                    failed={fps.failed}
                />

                {/* QR Button */}
                <Button
                    title="Generate QR Code"
                    icon="qrCode"
                    onPress={() => navigation.navigate("QR")}
                    style={styles.qrBtn}
                />

                {/* Family */}
                <Card title={`Family Members (${family?.length})`} icon="family" style={styles.card}>
                    {family?.map((m, i) => (
                        <View key={i} style={styles.memberRow}>
                            <Avatar name={m.name} size={typography.size.xxl} />
                            <View style={styles.memberTextCol}>
                                <View style={styles.memberNameRow}>
                                    <Text style={styles.memberName}>{m.name}</Text>
                                    {m.is_head && (
                                        <Icon
                                            name="headOfFamily"
                                            size={typography.size.xs}
                                            color={colors.warning}
                                            style={styles.headIcon}
                                            accessibilityLabel="Head of family"
                                        />
                                    )}
                                </View>
                                <Text style={styles.memberAge}>{m.age} yrs</Text>
                            </View>
                        </View>
                    ))}
                </Card>

                {/* Transactions */}
                <Card title="Recent Transactions" icon="transactions" style={[styles.card, styles.lastCard]}>
                    {transactions?.length === 0 ? (
                        <EmptyState
                            icon="emptyTransactions"
                            message="No transactions yet — your purchase history will show up here."
                        />
                    ) : (
                        transactions?.map((t) => (
                            <View key={t.id} style={styles.txRow}>
                                <View>
                                    <Text style={styles.txShop}>{t.shop_name}</Text>
                                    <Text style={styles.txDate}>
                                        {new Date(t.created_at).toLocaleDateString("en-IN", {
                                            day: "numeric", month: "short", year: "numeric",
                                        })}
                                    </Text>
                                </View>
                                <View style={styles.txQtys}>
                                    {t.rice_qty_kg > 0 && (
                                        <TxQty icon="grainRice" value={t.rice_qty_kg} color={colors.grain.rice} />
                                    )}
                                    {t.wheat_qty_kg > 0 && (
                                        <TxQty icon="grainWheat" value={t.wheat_qty_kg} color={colors.grain.wheat} />
                                    )}
                                </View>
                            </View>
                        ))
                    )}
                </Card>
            </ScrollView>

            {/* Logout */}
            <Button title="Logout" variant="dangerOutline" onPress={handleLogout} style={styles.logoutBtn} />
        </SafeAreaView>
    );
}

function GrainItem({ label, icon, value, entitlement, unit, color }) {
    const balance = value ?? 0;
    const usedPct = entitlement > 0 ? Math.max(0, Math.min(100, Math.round(((entitlement - balance) / entitlement) * 100))) : 0;

    return (
        <View style={styles.grainItem}>
            <Icon name={icon} size={typography.size.base} color={color} />
            <Text style={[styles.grainValue, { color }]}>{balance}</Text>
            <Text style={styles.grainUnit}>{unit} left</Text>
            <Text style={styles.grainLabel}>{label}</Text>
            <ProgressBar
                value={usedPct}
                max={100}
                color={color}
                label={`${label} entitlement: ${usedPct}% used this month`}
                style={styles.grainProgress}
            />
        </View>
    );
}

function TxQty({ icon, value, color }) {
    return (
        <View style={styles.txQtyRow}>
            <Icon name={icon} size={typography.size.xs} color={color} />
            <Text style={[styles.txQty, { color }]}>{value}kg</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    padding: { padding: spacing.base },
    // ScreenHeader already supplies flexDirection/justifyContent/background;
    // only the padding differs from its default here.
    header: { padding: spacing.lg, paddingTop: spacing.base },
    greetingRow: { flexDirection: "row", alignItems: "center" },
    greeting: {
        color: colors.onPrimary,
        fontSize: typography.size.sm, // was 13 -> rounds to 14
        marginLeft: spacing.xs,
    },
    name: {
        color: colors.onPrimary,
        fontSize: typography.size.lg,
        fontWeight: typography.weight.bold,
        marginTop: spacing.xs, // was 2 -> rounds to 4
    },
    cardNum: { color: colors.onPrimary, fontSize: typography.size.xs, marginTop: spacing.xs },
    // Card primitive already supplies background/radius/padding/elevation;
    // only the outer margin differs per screen.
    card: { margin: spacing.base, marginBottom: 0 },
    lastCard: { marginBottom: spacing.xxl },
    grainRow: { flexDirection: "row", justifyContent: "space-around" },
    grainItem: { alignItems: "center", width: "30%" },
    grainValue: { fontSize: typography.size.xl, fontWeight: typography.weight.bold, marginTop: spacing.xs },
    grainUnit: {
        fontSize: typography.size.xs,
        color: colors.textMuted,
        marginTop: -spacing.xs,
    },
    grainLabel: {
        fontSize: typography.size.sm, // was 13 -> rounds to 14
        color: colors.textSecondary, // was #444 -> textSecondary
        marginTop: spacing.xs,
    },
    grainProgress: { width: "100%", marginTop: spacing.sm },
    qrBtn: {
        margin: spacing.base,
        marginBottom: 0,
        padding: spacing.lg, // was 18 -> rounds to 20
        borderRadius: radius.md, // was 14 -> merged onto the shared card radius (16)
    },
    memberRow: {
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.border, // was #f0f0f0 -> shared border token
    },
    memberTextCol: { flex: 1, marginLeft: spacing.sm },
    memberNameRow: { flexDirection: "row", alignItems: "center" },
    memberName: { fontSize: typography.size.base, color: colors.textPrimary }, // was 15 -> rounds to 16
    headIcon: { marginLeft: spacing.xs },
    memberAge: { fontSize: typography.size.sm, color: colors.textMuted }, // was #888 -> textMuted
    txRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingVertical: spacing.md, // was 10 -> rounds to 12
        borderBottomWidth: 1,
        borderBottomColor: colors.border, // was #f0f0f0 -> shared border token
    },
    txShop: { fontSize: typography.size.sm, fontWeight: typography.weight.semibold, color: colors.textPrimary },
    txDate: { fontSize: typography.size.xs, color: colors.textMuted, marginTop: spacing.xs }, // was 2/#888
    txQtys: { alignItems: "flex-end" },
    txQtyRow: { flexDirection: "row", alignItems: "center" },
    txQty: {
        fontSize: typography.size.xs,
        marginLeft: spacing.xs,
    },
    logoutBtn: { margin: spacing.base },
});
