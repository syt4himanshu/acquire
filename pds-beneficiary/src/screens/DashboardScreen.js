import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, RefreshControl, Alert, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import api from "../api/axios";
import { useAuth } from "../context/AuthContext";
import FpsStatusCard from "../components/FpsStatusCard";
import { describeApiError } from "../lib/apiError";
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

// Each dashboard section is its own request, so a failure in one (for example a
// missing wallet) cannot blank the others. Each loader returns only the part of
// the response the screen renders.
const SECTION_LOADERS = {
    profile: () => api.get("/api/beneficiary/me").then((res) => res.data.beneficiary),
    wallet: () => api.get("/api/beneficiary/wallet").then((res) => res.data),
    family: () => api.get("/api/beneficiary/family").then((res) => res.data.family),
    transactions: () => api.get("/api/beneficiary/transactions?limit=5").then((res) => res.data.transactions),
};
const SECTION_NAMES = Object.keys(SECTION_LOADERS);

// Each section is { status: "loading" | "ok" | "error", data, error }. A failed
// section keeps no data, so an old value is never shown as if it were current.
const INITIAL_SECTIONS = Object.fromEntries(
    SECTION_NAMES.map((name) => [name, { status: "loading", data: null, error: null }]),
);

// The FPS status is polled, not pushed: the only shop-level live channel is the
// shopkeeper's own socket, and beneficiaries have no socket. A 30 s poll is
// enough for an Open/Closed flag and a queue estimate.
const FPS_POLL_INTERVAL_MS = 30000;

export default function DashboardScreen({ navigation }) {
    const { logout } = useAuth();
    const toast = useToast();
    const [sections, setSections] = useState(INITIAL_SECTIONS);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [fps, setFps] = useState({ snapshot: null, fetchedAtMs: null, failed: false });
    const [clockMs, setClockMs] = useState(() => Date.now());

    // Separate from loadSections so a failing FPS request cannot break the wallet
    // and transaction data. A 401 is left to loadSections, which logs out.
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

    const loadSections = useCallback(async () => {
        const results = await Promise.allSettled(SECTION_NAMES.map((name) => SECTION_LOADERS[name]()));

        const unauthorized = results.some(
            (result) => result.status === "rejected" && result.reason?.response?.status === 401,
        );
        if (unauthorized) {
            logout();
            return;
        }

        const failedCount = results.filter((result) => result.status === "rejected").length;
        setSections(
            Object.fromEntries(
                SECTION_NAMES.map((name, i) => {
                    const result = results[i];
                    return [
                        name,
                        result.status === "fulfilled"
                            ? { status: "ok", data: result.value, error: null }
                            : { status: "error", data: null, error: describeApiError(result.reason) },
                    ];
                }),
            ),
        );

        if (failedCount > 0) {
            toast.show("Some information could not be loaded. Pull down to retry.", { variant: "error" });
        }
        setLoading(false);
        setRefreshing(false);
    }, [logout, toast]);

    // Runs on mount and every time the dashboard regains focus (for example when
    // coming back from the QR screen), so the figures are not left stale.
    useFocusEffect(
        useCallback(() => {
            loadSections();
        }, [loadSections]),
    );

    const onRefresh = () => { setRefreshing(true); loadSections(); };

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

    const { profile, wallet, family, transactions } = sections;
    const beneficiary = profile.data;
    const catColor = colors.category[beneficiary?.category?.toLowerCase()] || colors.textSecondary;
    const familyTitle = family.status === "ok" ? `Family Members (${family.data.length})` : "Family Members";

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
                showsVerticalScrollIndicator={false}
            >
                {/* Header */}
                <ScreenHeader align="flex-start" style={styles.header}>
                    <View style={styles.headerText}>
                        <View style={styles.greetingRow}>
                            <Icon name="greeting" size={typography.size.xs} color={colors.onPrimary} />
                            <Text style={styles.greeting}>Welcome back</Text>
                        </View>
                        {profile.status === "ok" && (
                            <>
                                <Text style={styles.name}>{beneficiary.head_name || "Name unavailable"}</Text>
                                <Text style={styles.cardNum}>Card: {beneficiary.card_number}</Text>
                            </>
                        )}
                        {profile.status === "error" && (
                            <>
                                <Text style={styles.name}>Profile unavailable</Text>
                                <Text style={styles.cardNum}>{profile.error.message}</Text>
                                <RetryLink onPress={loadSections} />
                            </>
                        )}
                    </View>
                    {profile.status === "ok" && (
                        <Badge
                            label={beneficiary.category}
                            color={catColor}
                            accessibilityLabel={`Ration card category: ${beneficiary.category}`}
                        />
                    )}
                </ScreenHeader>

                {/* Wallet */}
                <Card title="Monthly Wallet" icon="wallet" style={styles.card}>
                    <WalletBody section={wallet} onRetry={loadSections} />
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
                <Card title={familyTitle} icon="family" style={styles.card}>
                    <FamilyBody section={family} onRetry={loadSections} />
                </Card>

                {/* Transactions */}
                <Card title="Recent Transactions" icon="transactions" style={[styles.card, styles.lastCard]}>
                    <TransactionsBody section={transactions} onRetry={loadSections} />
                </Card>
            </ScrollView>

            {/* Logout */}
            <Button title="Logout" variant="dangerOutline" onPress={handleLogout} style={styles.logoutBtn} />
        </SafeAreaView>
    );
}

// The wallet response is { wallet, allocation_status, entitlement }. A null
// wallet means the card has no allocation yet, which is not the same as a zero
// balance, so it gets its own message.
function WalletBody({ section, onRetry }) {
    if (section.status === "loading") return <Text style={styles.muted}>Loading wallet…</Text>;
    if (section.status === "error") return <SectionError message={section.error.message} onRetry={onRetry} />;

    const { wallet, entitlement } = section.data;
    if (!wallet) {
        return (
            <EmptyState
                icon="wallet"
                message="Monthly allocation not available yet. Your FPS shop can confirm when it is set up."
            />
        );
    }

    return (
        <>
            <View style={styles.grainRow}>
                <GrainItem
                    label="Rice"
                    icon="grainRice"
                    value={wallet.rice_balance_kg}
                    entitlementKg={entitlement?.rice_kg}
                    color={colors.grain.rice}
                />
                <GrainItem
                    label="Wheat"
                    icon="grainWheat"
                    value={wallet.wheat_balance_kg}
                    entitlementKg={entitlement?.wheat_kg}
                    color={colors.grain.wheat}
                />
            </View>
            {wallet.last_reset_date && (
                <Text style={styles.caption}>Allocated on {formatDate(wallet.last_reset_date)}</Text>
            )}
        </>
    );
}

function FamilyBody({ section, onRetry }) {
    if (section.status === "loading") return <Text style={styles.muted}>Loading family members…</Text>;
    if (section.status === "error") return <SectionError message={section.error.message} onRetry={onRetry} />;
    if (section.data.length === 0) {
        return <EmptyState icon="family" message="No family members are linked to this ration card." />;
    }

    return section.data.map((m, i) => (
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
    ));
}

function TransactionsBody({ section, onRetry }) {
    if (section.status === "loading") return <Text style={styles.muted}>Loading transactions…</Text>;
    if (section.status === "error") return <SectionError message={section.error.message} onRetry={onRetry} />;
    if (section.data.length === 0) {
        return (
            <EmptyState
                icon="emptyTransactions"
                message="No transactions yet — your purchase history will show up here."
            />
        );
    }

    return section.data.map((t) => (
        <View key={t.id} style={styles.txRow}>
            <View>
                <Text style={styles.txShop}>{t.shop_name}</Text>
                <Text style={styles.txDate}>{formatDate(t.created_at)}</Text>
            </View>
            <View style={styles.txQtys}>
                {t.rice_qty_kg > 0 && <TxQty icon="grainRice" value={t.rice_qty_kg} color={colors.grain.rice} />}
                {t.wheat_qty_kg > 0 && <TxQty icon="grainWheat" value={t.wheat_qty_kg} color={colors.grain.wheat} />}
            </View>
        </View>
    ));
}

function SectionError({ message, onRetry }) {
    return (
        <View style={styles.sectionError} accessibilityRole="alert">
            <Text style={styles.errorText}>{message}</Text>
            <RetryLink onPress={onRetry} />
        </View>
    );
}

function RetryLink({ onPress }) {
    return (
        <TouchableOpacity onPress={onPress} accessibilityRole="button" accessibilityLabel="Try again" style={styles.retry}>
            <Text style={styles.retryText}>Try again</Text>
        </TouchableOpacity>
    );
}

function GrainItem({ label, icon, value, entitlementKg, color }) {
    // Used % only makes sense against the card's real allocation. Without one, the
    // bar is omitted rather than drawn against a made-up total.
    const hasEntitlement = typeof entitlementKg === "number" && entitlementKg > 0;
    const usedPct = hasEntitlement
        ? Math.max(0, Math.min(100, Math.round(((entitlementKg - value) / entitlementKg) * 100)))
        : null;

    return (
        <View style={styles.grainItem}>
            <Icon name={icon} size={typography.size.base} color={color} />
            <Text style={[styles.grainValue, { color }]}>{value}</Text>
            <Text style={styles.grainUnit}>kg left</Text>
            <Text style={styles.grainLabel}>{label}</Text>
            {usedPct !== null && (
                <ProgressBar
                    value={usedPct}
                    max={100}
                    color={color}
                    label={`${label} allocation: ${usedPct}% used this month`}
                    style={styles.grainProgress}
                />
            )}
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

// Dates from the API are date-only ("2026-09-26") or full timestamps. Date-only
// values are parsed as local midnight so they do not shift a day in India time.
function formatDate(value) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
    return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    padding: { padding: spacing.base },
    // ScreenHeader already supplies flexDirection/justifyContent/background;
    // only the padding differs from its default here.
    header: { padding: spacing.lg, paddingTop: spacing.base },
    headerText: { flex: 1, marginRight: spacing.sm },
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
    retry: { marginTop: spacing.sm, alignSelf: "flex-start" },
    retryText: {
        color: colors.onPrimary,
        fontSize: typography.size.sm,
        fontWeight: typography.weight.semibold,
        textDecorationLine: "underline",
    },
    // Card primitive already supplies background/radius/padding/elevation;
    // only the outer margin differs per screen.
    card: { margin: spacing.base, marginBottom: 0 },
    lastCard: { marginBottom: spacing.xxl },
    muted: { fontSize: typography.size.sm, color: colors.textMuted },
    caption: { fontSize: typography.size.xs, color: colors.textMuted, marginTop: spacing.sm, textAlign: "center" },
    sectionError: { paddingVertical: spacing.sm },
    errorText: { fontSize: typography.size.sm, color: colors.danger },
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
