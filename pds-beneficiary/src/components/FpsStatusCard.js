import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, spacing, typography } from "../theme";
import { Card, Badge, SkeletonCard } from "./primitives";
import {
    availabilityNow,
    queueNow,
    ageNow,
    formatAgo,
    queueSentence,
} from "../lib/fpsStatus";

const AVAILABILITY_META = {
    open: { label: "OPEN", color: colors.success, hint: "Open for distribution" },
    closed: { label: "CLOSED", color: colors.danger, hint: "Closed right now" },
    unknown: {
        label: "STATUS NOT REPORTED",
        color: colors.warning,
        hint: "The shopkeeper has not confirmed today's status. Check with the shop.",
    },
};

// Shows the FPS's Open/Closed state and queue estimate. Every age is labelled
// ("Updated" or "Last reported"), and nothing is shown as live unless it is
// recent. Ages are advanced to nowMs so a snapshot kept on screen, or kept
// while offline, ages honestly.
export default function FpsStatusCard({ snapshot, fetchedAtMs, nowMs, failed }) {
    if (!snapshot) {
        return (
            <Card title="Your FPS" icon="fpsShop" style={styles.card}>
                {failed ? (
                    <Text style={styles.muted} accessibilityRole="alert">
                        Couldn't load your FPS status. It will retry automatically.
                    </Text>
                ) : (
                    <SkeletonCard height={90} />
                )}
            </Card>
        );
    }

    const thresholds = snapshot.thresholds;
    const availability = availabilityNow(snapshot.availability, fetchedAtMs, nowMs, thresholds);
    const queue = queueNow(snapshot.queue, fetchedAtMs, nowMs, thresholds);
    const meta = AVAILABILITY_META[availability.status];
    const lastLoadedAgo = formatAgo(ageNow(0, fetchedAtMs, nowMs));

    return (
        <Card title="Your FPS" icon="fpsShop" style={styles.card}>
            <Text style={styles.shopName} accessibilityRole="header">
                {snapshot.shop_name}
            </Text>

            <View style={styles.row}>
                <Badge
                    label={meta.label}
                    color={meta.color}
                    accessibilityLabel={`Shop status: ${meta.label.toLowerCase()}`}
                />
            </View>
            <Text style={styles.muted}>
                {meta.hint}
                {availability.ageSeconds !== null && availability.status !== "unknown"
                    ? ` · Set ${formatAgo(availability.ageSeconds)}`
                    : ""}
            </Text>

            <View style={styles.divider} />

            {queue.freshness === "none" ? (
                <Text style={styles.muted}>No queue estimate yet.</Text>
            ) : (
                <>
                    <Text style={styles.queueCount} accessibilityLabel={queueSentence(queue.count)}>
                        {queueSentence(queue.count)}
                    </Text>
                    <Text
                        style={queue.freshness === "current" ? styles.muted : styles.stale}
                        accessibilityLabel={
                            queue.freshness === "current"
                                ? `Updated ${formatAgo(queue.ageSeconds)}`
                                : `Last reported ${formatAgo(queue.ageSeconds)}`
                        }
                    >
                        {queue.freshness === "current"
                            ? `Updated ${formatAgo(queue.ageSeconds)}`
                            : `Last reported ${formatAgo(queue.ageSeconds)}. This may have changed.`}
                    </Text>
                </>
            )}

            {failed && (
                <Text style={styles.offline} accessibilityRole="alert">
                    Offline. Showing the status from {lastLoadedAgo}.
                </Text>
            )}
        </Card>
    );
}

const styles = StyleSheet.create({
    card: { margin: spacing.base, marginBottom: 0 },
    shopName: {
        fontSize: typography.size.base,
        fontWeight: typography.weight.semibold,
        color: colors.textPrimary,
    },
    row: { flexDirection: "row", marginTop: spacing.sm },
    muted: { fontSize: typography.size.sm, color: colors.textMuted, marginTop: spacing.xs },
    stale: { fontSize: typography.size.sm, color: colors.warning, marginTop: spacing.xs },
    offline: { fontSize: typography.size.sm, color: colors.warning, marginTop: spacing.md },
    divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
    queueCount: {
        fontSize: typography.size.xl,
        fontWeight: typography.weight.bold,
        color: colors.textPrimary,
    },
});
