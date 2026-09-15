import Foundation

enum ISO8601Parsing {
    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        let fractionalFormatter = ISO8601DateFormatter()
        fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = fractionalFormatter.date(from: value) {
            return parsed
        }
        return ISO8601DateFormatter().date(from: value)
    }
}

enum UsageParser {
    static func parse(_ payload: UsagePayload?) -> UsageSnapshot {
        guard let payload else {
            return UsageSnapshot(
                planType: nil,
                primaryUsedPercent: nil,
                primaryResetSeconds: nil,
                weeklyUsedPercent: nil,
                weeklyResetSeconds: nil
            )
        }

        let primarySlot = payload.rateLimit?.primaryWindow
        let secondarySlot = payload.rateLimit?.secondaryWindow
        var primaryWindow: UsageWindow?
        var weeklyWindow: UsageWindow?

        assign(primarySlot, legacyWeekly: false, primary: &primaryWindow, weekly: &weeklyWindow)
        assign(secondarySlot, legacyWeekly: true, primary: &primaryWindow, weekly: &weeklyWindow)

        return UsageSnapshot(
            planType: payload.planType,
            primaryUsedPercent: primaryWindow?.usedPercent,
            primaryResetSeconds: primaryWindow?.resetSeconds,
            weeklyUsedPercent: weeklyWindow?.usedPercent,
            weeklyResetSeconds: weeklyWindow?.resetSeconds
        )
    }

    private static func assign(
        _ window: UsageWindow?,
        legacyWeekly: Bool,
        primary: inout UsageWindow?,
        weekly: inout UsageWindow?
    ) {
        guard let window else { return }
        if let duration = window.limitWindowSeconds {
            if duration <= 6 * 60 * 60 {
                primary = primary ?? window
                return
            }
            if duration >= 24 * 60 * 60 {
                weekly = weekly ?? window
                return
            }
        }
        if legacyWeekly {
            weekly = weekly ?? window
        } else {
            primary = primary ?? window
        }
    }
}

enum UsageFormatting {
    static func percent(_ value: Double?) -> String {
        guard let value else { return "--" }
        return "\(Int(value.rounded()))%"
    }

    static func duration(_ seconds: TimeInterval?) -> String {
        guard let seconds else { return "--" }
        let totalMinutes = max(0, Int(seconds / 60))
        let days = totalMinutes / 1_440
        let hours = (totalMinutes % 1_440) / 60
        let minutes = totalMinutes % 60
        if days > 0 { return "\(days)天 \(hours)小时" }
        if hours > 0 { return "\(hours)小时 \(minutes)分" }
        return "\(minutes)分钟"
    }

    static func integer(_ value: Int64) -> String {
        value.formatted(.number.grouping(.automatic))
    }

    static func compactInteger(_ value: Int64) -> String {
        let magnitude = abs(Double(value))
        let divisor: Double
        let suffix: String
        switch magnitude {
        case 1_000_000_000...:
            divisor = 1_000_000_000
            suffix = "B"
        case 1_000_000...:
            divisor = 1_000_000
            suffix = "M"
        case 1_000...:
            divisor = 1_000
            suffix = "K"
        default:
            return integer(value)
        }
        return (Double(value) / divisor).formatted(.number.precision(.fractionLength(0 ... 2))) + suffix
    }

    static func milliseconds(_ value: Double) -> String {
        guard value > 0 else { return "--" }
        if value >= 1_000 {
            return (value / 1_000).formatted(.number.precision(.fractionLength(1 ... 2))) + "秒"
        }
        return Int(value.rounded()).formatted() + "ms"
    }

    static func usd(_ value: Double?) -> String {
        guard let value else { return "--" }
        return value.formatted(
            .currency(code: "USD")
                .precision(.fractionLength(2 ... 4))
        )
    }

    static func compactUSD(_ value: Double?) -> String {
        guard let value else { return "--" }
        return "$" + value.formatted(.number.precision(.fractionLength(2)))
    }

    static func usdOrUnlimited(_ remaining: Double?, limit: Double) -> String {
        guard limit > 0 else { return "不限额" }
        return usd(remaining)
    }

    static func timestamp(_ value: String?) -> String {
        guard let date = ISO8601Parsing.date(value) else { return "--" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    static func dateTime(_ value: String?) -> String {
        guard let date = ISO8601Parsing.date(value) else { return "--" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
