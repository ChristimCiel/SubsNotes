import AppKit
import SwiftUI
import WidgetKit

private enum Inventory {
    case loaded([Subscription])
    case unreadable
}

private struct LedgerEntry: TimelineEntry {
    var date: Date
    var inventory: Inventory
}

private struct Provider: TimelineProvider {
    private func snapshot() -> LedgerEntry {
        do {
            return LedgerEntry(date: Date(), inventory: .loaded(try RecordStore(url: StoragePaths.recordsURL()).load()))
        } catch {
            return LedgerEntry(date: Date(), inventory: .unreadable)
        }
    }

    func placeholder(in context: Context) -> LedgerEntry {
        // WidgetKit redacts this gallery placeholder. No fictional entry is ever persisted.
        var sample = Subscription()
        sample.name = L10n.text("Example subscription")
        sample.currency = "USD"
        sample.amount = 12
        sample.cadence = .monthly
        sample.nextBilling = Day.fromLocal(.now)
        return LedgerEntry(date: .now, inventory: .loaded([sample]))
    }

    func getSnapshot(in context: Context, completion: @escaping (LedgerEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : snapshot())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LedgerEntry>) -> Void) {
        let entry = snapshot()
        let calendar = Calendar.autoupdatingCurrent
        let midnight = calendar.dateInterval(of: .day, for: entry.date)?.end ?? entry.date.addingTimeInterval(3600)
        // Supply tomorrow's entry in advance; system scheduling can defer provider refresh.
        let tomorrow = LedgerEntry(date: midnight, inventory: entry.inventory)
        completion(Timeline(entries: [entry, tomorrow], policy: .after(midnight)))
    }
}

private struct BillingEvent {
    let item: Subscription
    let decision: DecisionPlan

    static func highlight(in items: [Subscription], now: Date) -> BillingEvent? {
        let events = items.compactMap { item -> BillingEvent? in
            let decision = DecisionPlan.make(item, now: now)
            guard decision.needsReview else { return nil }
            return BillingEvent(item: item, decision: decision)
        }.sorted {
            let left = $0.decision.dueOn ?? .distantFuture
            let right = $1.decision.dueOn ?? .distantFuture
            return left == right ? $0.item.name.localizedStandardCompare($1.item.name) == .orderedAscending : left < right
        }
        return events.first
    }
}

private struct LedgerWidgetView: View {
    let entry: LedgerEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var appearance

    private var small: Bool { family == .systemSmall }
    private var targetURL: URL? {
        if case .loaded(let items) = entry.inventory,
           let event = BillingEvent.highlight(in: items, now: entry.date) {
            return URL(string: "renewbefore://open/review/" + event.item.id.uuidString)
        }
        return URL(string: "renewbefore://open")
    }
    private var accent: Color { appearance == .dark ? Color(red: 0.63, green: 0.84, blue: 0.70) : Color(red: 0.12, green: 0.35, blue: 0.26) }
    private var paper: Color { appearance == .dark ? Color(red: 0.10, green: 0.17, blue: 0.14) : Color(red: 0.96, green: 0.97, blue: 0.93) }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 5) {
                Image(systemName: "calendar.badge.clock")
                Text("RENEW BEFORE").tracking(0.8)
            }.font(.system(size: 10, weight: .bold, design: .monospaced)).foregroundStyle(accent)
            switch entry.inventory {
            case .unreadable:
                message("Ledger unavailable", hint: "Open Renew Before to check your data.")
            case .loaded(let items) where items.isEmpty:
                message("No subscriptions yet", hint: "Open Renew Before to add your first plan.")
            case .loaded(let items):
                let event = BillingEvent.highlight(in: items, now: entry.date)
                HStack(alignment: .top, spacing: 14) {
                    VStack(alignment: .leading, spacing: 3) {
                        if let event {
                            HStack(spacing: 6) {
                                if let url = ServiceLogoCatalog.imageURL(for: event.item.name), let image = NSImage(contentsOf: url) {
                                    Image(nsImage: image).resizable().scaledToFit().padding(3)
                                        .frame(width: 24, height: 24)
                                        .background(ServiceLogoCatalog.logo(for: event.item.name)?.backdrop == "dark" ? Color(white: 0.12) : Color.white,
                                                    in: RoundedRectangle(cornerRadius: 6))
                                        .accessibilityHidden(true)
                                }
                                Text(event.item.name).font(.system(size: small ? 17 : 21, weight: .semibold, design: .serif)).lineLimit(2)
                            }
                            Text(L10n.text(event.decision.isOverdue ? "Review overdue" : "Review by"))
                                .font(.caption).foregroundStyle(.secondary)
                            Text(event.decision.dueOn.map { L10n.date(Day.toLocal($0)) } ?? L10n.text("Choose a date"))
                                .font(.callout.weight(.medium))
                            Spacer(minLength: 0)
                            Text(L10n.format("Last verified %@", L10n.date(event.item.verifiedAt)))
                                .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
                        } else {
                            Text("No open decisions").font(.headline)
                            Text("Open your dashboard to review your plans.").font(.caption).foregroundStyle(.secondary)
                        }
                    }.frame(maxWidth: .infinity, alignment: .topLeading)
                    if !small {
                        Divider()
                        costSummary(items)
                    }
                }
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .containerBackground(for: .widget) { paper }
            .widgetURL(targetURL)
    }

    private func message(_ title: String, hint: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(L10n.text(title)).font(.system(size: 18, weight: .semibold, design: .serif))
            Text(L10n.text(hint)).font(.caption).foregroundStyle(.secondary)
        }.frame(maxHeight: .infinity, alignment: .center)
    }

    private func costSummary(_ items: [Subscription]) -> some View {
        let summary = Ledger.spendingSummary(items)
        let totals = summary.monthlyByCurrency
        let codes = totals.keys.sorted()
        return VStack(alignment: .leading, spacing: 5) {
            Text("MONTHLY EQUIV.").font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(0.3).foregroundStyle(.secondary)
            if codes.isEmpty {
                Text(L10n.text(summary.excludedActiveCount > 0 ? "Pricing incomplete" : "No renewing plans")).font(.caption)
            } else {
                ForEach(codes.prefix(2), id: \.self) { code in
                    Text(Ledger.displayMoney(totals[code]!, code)).font(.system(.body, design: .rounded, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.7)
                }
                if codes.count > 2 { Text(L10n.format("+%lld more currencies", codes.count - 2)).font(.caption2).foregroundStyle(.secondary) }
                if summary.excludedActiveCount > 0 { Text("Some prices missing").font(.caption2).foregroundStyle(.secondary) }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

@main
struct RenewBeforeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RenewBeforeWidget", provider: Provider()) { entry in
            LedgerWidgetView(entry: entry).environment(\.locale, L10n.locale)
        }
        .configurationDisplayName("Renew Before")
        .description(Text(L10n.text("See your next project or subscription decision and monthly costs.")))
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
