const DEFAULTS = {
    colors: {
        background: "#111827",
        card: "#1F2937",
        accent: "#3B82F6",
        success: "#22C55E",
        warning: "#F59E0B",
        danger: "#EF4444",
        text: "#F9FAFB",
        muted: "#9CA3AF"
    },
    radius: 16,
    gap: 18,
    padding: 18
};

if (typeof module !== "undefined") {
    module.exports = DEFAULTS;
}