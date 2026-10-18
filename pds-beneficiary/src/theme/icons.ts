// Semantic icon lookup table. Screens ask for a semantic key (e.g.
// "wallet") instead of picking an icon family/name ad hoc, so there is one
// place that decides what each concept looks like.
//
// Resolves the audit's flagged icon inconsistencies:
//   - "brand" (login logo) and "wallet" (wallet card title) used to share
//     the same emoji glyph for two unrelated meanings — they now point at
//     two distinct icons.
//   - "grainWheat" is the ONE icon used everywhere wheat is represented
//     (previously a different emoji glyph in each place).
export const icons = {
    brand: { family: "Ionicons", name: "leaf-outline" },
    wallet: { family: "Ionicons", name: "wallet-outline" },
    family: { family: "Ionicons", name: "people-outline" },
    transactions: { family: "Ionicons", name: "receipt-outline" },
    fpsShop: { family: "Ionicons", name: "storefront-outline" },
    greeting: { family: "MaterialCommunityIcons", name: "hand-wave" },
    headOfFamily: { family: "Ionicons", name: "star" },
    grainRice: { family: "MaterialCommunityIcons", name: "rice" },
    grainWheat: { family: "MaterialCommunityIcons", name: "barley" },
    qrCode: { family: "Ionicons", name: "qr-code" },
    qrExpired: { family: "Ionicons", name: "time-outline" },
    refresh: { family: "Ionicons", name: "refresh" },
    back: { family: "Ionicons", name: "arrow-back" },

    // Toast variants + dismiss control.
    success: { family: "Ionicons", name: "checkmark-circle" },
    error: { family: "Ionicons", name: "alert-circle" },
    info: { family: "Ionicons", name: "information-circle" },
    dismiss: { family: "Ionicons", name: "close" },

    // Empty-state pattern (transactions card).
    emptyTransactions: { family: "Ionicons", name: "receipt-outline" },
};
