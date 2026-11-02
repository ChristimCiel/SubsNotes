import AppKit
import ServiceManagement
import SwiftUI
import UniformTypeIdentifiers

// Dynamic ink and paper keep the ledger legible in both macOS appearances.
private func paperColor(_ day: UInt32, _ night: UInt32) -> Color {
    func color(_ hex: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
    }
    return Color(nsColor: NSColor(name: nil) { a in color(a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? night : day) })
}

enum Palette {
    static let paper = paperColor(0xF8F7F2, 0x1B201F)
    static let card = paperColor(0xFFFefa, 0x242B29)
    static let ink = paperColor(0x162C27, 0xEEF4EF)
    static let muted = paperColor(0x53655F, 0xB4C0B8)
    static let line = paperColor(0xD6DED6, 0x3D4742)
    static let tint = paperColor(0x25634F, 0x8DD4B2)
    static let pale = paperColor(0xE5EDE5, 0x32463D)
}

struct Eyebrow: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(LocalizedStringKey(text)).textCase(.uppercase).font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(0.7).foregroundStyle(Palette.muted)
    }
}

private enum PanelSheet: Identifiable {
    case add, paste, edit(Subscription), review(ReceiptDraft), preferences, scan, scanCandidate(MailCandidate), payment
    var id: String {
        switch self {
        case .scan: return "scan"
        case .payment: return "payment"
        case .scanCandidate(let candidate): return "match-" + candidate.id
        case .add: return "add"
        case .paste: return "paste"
        case .edit(let item): return item.id.uuidString
        case .review(let draft): return "receipt-" + draft.receiptID
        case .preferences: return "preferences"
        }
    }
}

private enum ServiceFilter: String, CaseIterable {
    case all = "All", active = "Renewing", canceled = "Renewal off", review = "Needs review"
}

private enum DashboardTab: String, CaseIterable {
    case decisions = "Subscriptions", spending = "Payments"
}

struct LedgerView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var options: PanelOptions
    @StateObject private var scan = EmailScanController()
    @State private var sheet: PanelSheet?
    @State private var search = ""
    @State private var filter: ServiceFilter = .all
    @State private var failure: String?
    @State private var period: PaymentPeriod = .last30
    @State private var tab: DashboardTab = .decisions
    @State private var selectedSubscriptionID: UUID?

    private var pending: [MailCandidate] { scan.pending(for: model.items) }

    private func matchesSearch(_ name: String) -> Bool {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty || name.localizedCaseInsensitiveContains(query)
    }

    private var listed: [Subscription] {
        model.items.filter { item in
            guard matchesSearch(item.name) else { return false }
            switch filter {
            case .all: return true
            case .active: return item.status == .active
            case .canceled: return item.status != .active
            case .review: return false
            }
        }.sorted {
            let left = ($0.status == .active ? $0.nextBilling : $0.accessEnds) ?? .distantFuture
            let right = ($1.status == .active ? $1.nextBilling : $1.accessEnds) ?? .distantFuture
            return left != right ? left < right : $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }

    private var listedPending: [MailCandidate] {
        pending.filter { match in
            guard matchesSearch(match.name) else { return false }
            switch filter {
            case .all, .review: return true
            case .active, .canceled: return false
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 9) {
                Image(systemName: "calendar.badge.clock").font(.system(size: 20, weight: .medium)).foregroundStyle(Palette.tint)
                Text("Renew Before").font(.system(size: 22, weight: .semibold, design: .rounded))
                Spacer(minLength: 6)
                Button(action: beginScan) { Label("Scan Gmail", systemImage: "envelope.badge") }
                    .buttonStyle(.bordered).accessibilityLabel("Scan Gmail")
                alternativeEntries
                Button { sheet = .preferences } label: { Image(systemName: "gearshape").font(.system(size: 16)).padding(5) }
                    .buttonStyle(.plain).accessibilityLabel("Settings").help("Settings")
            }.padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 13)
            HStack {
                Picker("Dashboard view", selection: $tab) {
                    ForEach(DashboardTab.allCases, id: \.self) { value in Text(LocalizedStringKey(value.rawValue)).tag(value) }
                }.pickerStyle(.segmented).labelsHidden().frame(maxWidth: 275).accessibilityLabel("Dashboard view")
                Spacer(minLength: 8)
            }.padding(.horizontal, 20).padding(.bottom, 12)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let notice = model.notice {
                        HStack(alignment: .top) {
                            Image(systemName: "info.circle")
                            Text(notice).font(.callout).textSelection(.enabled)
                            Spacer()
                            Button { model.notice = nil } label: { Image(systemName: "xmark") }
                                .buttonStyle(.plain).accessibilityLabel("Dismiss notice")
                        }.padding(10).background(Palette.pale, in: RoundedRectangle(cornerRadius: 9))
                    }
                    if let warning = scan.storageWarning {
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(.callout).fixedSize(horizontal: false, vertical: true)
                    }
                    if tab == .decisions {
                        if let id = selectedSubscriptionID {
                            SubscriptionReviewView(model: model, scan: scan, id: id,
                                                   back: { selectedSubscriptionID = nil }, edit: { sheet = .edit($0) })
                                .id(id)
                        } else {
                            SubscriptionHomeView(model: model, scan: scan, review: { selectedSubscriptionID = $0.id },
                                                 reviewEmail: { sheet = .scanCandidate($0) }, add: { sheet = .add })
                        }
                    } else {
                        spendingOverview
                        if !scan.currencyReviews.isEmpty || !scan.paymentReviews.isEmpty {
                            DisclosureGroup(L10n.format("Receipts to check (%d)", scan.currencyReviews.count + scan.paymentReviews.count)) {
                                PaymentCurrencyReviews(scan: scan)
                                PaymentReceiptReviews(scan: scan)
                            }
                        }
                    }
                }.padding(.horizontal, 20).padding(.vertical, 16).id(options.language)
            }
            Divider()
            HStack(spacing: 6) {
                Image(systemName: "lock"); Text("Stored on this Mac")
                Spacer()
                if let lastScan = scan.lastScanAt {
                    Text(L10n.format("Last scan %@", L10n.date(lastScan, includeTime: true)))
                        .lineLimit(1).help(scan.connectedAddress ?? "")
                } else if scan.connectedAddress != nil {
                    Text("Gmail connected")
                } else {
                    Text(options.shortcut).font(.system(.caption, design: .monospaced))
                }
            }.font(.caption).foregroundStyle(Palette.muted).padding(.horizontal, 20).padding(.vertical, 8)
        }
        .foregroundStyle(Palette.ink).tint(Palette.tint).frame(maxWidth: .infinity, maxHeight: .infinity).background(Palette.paper)
        .sheet(item: $sheet) { sheet in
            Group {
            switch sheet {
            case .payment: PaymentEntryView(scan: scan)
            case .add: SubscriptionEditor(model: model)
            case .paste: PasteReceiptView(model: model) { draft in self.sheet = .review(draft) }
            case .edit(let item): SubscriptionEditor(model: model, existing: item)
            case .review(let draft): ReviewDestinationView(model: model, draft: draft)
            case .scan: ScanEmailView(scan: scan, model: model).onDisappear { scan.close() }
            case .scanCandidate(let candidate):
                if candidate.kind != .paymentProblem && !model.items.contains(where: { $0.name.localizedCaseInsensitiveCompare(candidate.name) == .orderedSame }) {
                    ConfirmEmailSubscriptionView(model: model, scan: scan, candidate: candidate)
                } else { ScanEmailView(scan: scan, model: model, candidate: candidate) }
            case .preferences:
                PreferencesView(model: model, options: options, scan: scan) {
                    self.sheet = .scan
                    scan.changeAccount()
                }
            }
            }.environment(\.locale, options.language.locale)
        }
        .onAppear { openRequestedSubscription() }
        .onChange(of: options.language) { _, _ in model.refresh() }
        .onChange(of: model.requestedSubscriptionID) { _, _ in openRequestedSubscription() }
        .alert("Couldn’t open this receipt", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) { Button("OK") { failure = nil } } message: { Text(failure ?? "") }
        .environment(\.locale, options.language.locale)
    }

    private func openRequestedSubscription() {
        guard let id = model.requestedSubscriptionID else { return }
        model.requestedSubscriptionID = nil
        tab = .decisions
        guard let item = model.items.first(where: { $0.id == id }) else { return }
        selectedSubscriptionID = item.id
    }

    private var spendingOverview: some View {
        let summary = PaymentSummary(payments: scan.payments, period: period)
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(L10n.text("What you’ve paid")).font(.system(size: 29, weight: .semibold, design: .rounded)).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 6)
                Picker("Spending period", selection: $period) {
                    ForEach(PaymentPeriod.allCases, id: \.self) { value in Text(L10n.text(value.label)).tag(value) }
                }.labelsHidden().fixedSize().accessibilityLabel("Spending period")
            }
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 6) {
                    Image(systemName: "creditcard")
                    Text(L10n.text("From your recorded receipts")).font(.caption.weight(.medium))
                    Spacer()
                    Text(L10n.format("%d payments", summary.payments.count))
                        .font(.caption.weight(.medium)).monospacedDigit()
                }.foregroundStyle(Palette.muted)
                if summary.totals.isEmpty {
                    Text(L10n.text(emptySpendingTitle))
                        .font(.system(size: 27, weight: .medium, design: .serif))
                    Text(L10n.text(emptySpendingMessage)).font(.callout)
                } else {
                    ForEach(summary.totals.keys.sorted(), id: \.self) { currency in
                        if let total = summary.totals[currency] {
                            Text(Ledger.displayMoney(total, currency))
                                .font(.system(size: 33, weight: .medium, design: .rounded))
                                .monospacedDigit().textSelection(.enabled)
                        }
                    }
                    Text("Paid receipts and manual entries. Refunds and unpaid bills are excluded.")
                        .font(.callout)
                }
                if let address = scan.connectedAddress {
                    Label(address, systemImage: "envelope").lineLimit(1).truncationMode(.middle)
                        .font(.caption).foregroundStyle(Palette.muted)
                }
                if !scan.paymentReviews.isEmpty {
                    Text(L10n.format("%d receipts held for evidence review. Totals exclude these payments.", scan.paymentReviews.count))
                        .font(.caption).fixedSize(horizontal: false, vertical: true)
                }
            }
            .foregroundStyle(Palette.ink)
            .padding(.horizontal, 16).padding(.vertical, 13).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 16))
            .overlay { RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.line).allowsHitTesting(false) }
            // AppKit can cache the combined AX text when a currency row keeps its identity.
            // Recreate the summary when its period or amounts change, including receipt corrections.
            .id("paid-summary-" + period.rawValue + summary.totals.keys.sorted().map {
                $0 + NSDecimalNumber(decimal: summary.totals[$0]!).stringValue
            }.joined(separator: "|"))

            HStack {
                if !summary.byService.isEmpty {
                    Eyebrow("Spending by service")
                } else if let detail = coverageText {
                    Text(detail).font(.caption).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 5)
                Button { sheet = .payment } label: { Label("Record payment", systemImage: "plus.circle") }.controlSize(.small)
            }
            if !summary.byService.isEmpty {
                DisclosureGroup(L10n.text("Spending breakdown")) { SpendingChart(summary: summary) }
                ServicePayments(summary: summary) { payment in try scan.excludePayment(payment) }
                    .id(period.rawValue + (scan.connectedAddress ?? ""))
                if let detail = coverageText { Text(detail).font(.caption).foregroundStyle(Palette.muted) }
            }
        }
    }

    private var emptySpendingTitle: String {
        if scan.storageWarning != nil { return "Spending unavailable" }
        return scan.payments.isEmpty ? "No payments recorded" : "No payments in this period"
    }

    private var emptySpendingMessage: String {
        if scan.storageWarning != nil { return "Review the storage notice before adding payments." }
        if !scan.payments.isEmpty { return "Choose another period to see earlier payments." }
        if !scan.currencyReviews.isEmpty { return "Confirm the currencies below to include those receipts in your spending." }
        if scan.lastScanAt != nil {
            return "No receipts with a clear paid amount have been recorded. You can add a payment from a receipt."
        }
        return "Scan Gmail for paid receipts or record a payment from a receipt you have."
    }

    private var coverageText: String? {
        guard let coverage = scan.lastScanSummary else { return nil }
        var text = L10n.format("Latest scan checked %d matching emails from the last 90 days.", coverage.inspected)
        if !coverage.limitNote.isEmpty { text += " " + L10n.text(coverage.limitNote) }
        if coverage.skipped > 0 { text += " " + L10n.format("%d unreadable.", coverage.skipped) }
        return text
    }

    private var subscriptionsSection: some View {
        let saved = listed
        let matches = listedPending
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Your subscriptions").font(.system(size: 20, weight: .semibold)).accessibilityAddTraits(.isHeader)
                Spacer()
                Button { sheet = .add } label: { Label("Add without Gmail", systemImage: "plus") }.controlSize(.small)
            }
            if scan.connectedAddress != nil {
                Text("Saved plans on this Mac · Gmail matches from the selected account")
                    .font(.caption).foregroundStyle(Palette.muted)
            }
            Picker("Filter subscriptions", selection: $filter) {
                ForEach(ServiceFilter.allCases, id: \.self) { value in
                    Text(L10n.text(filterLabel(value))).tag(value)
                }
            }.pickerStyle(.segmented).labelsHidden().accessibilityLabel("Filter subscriptions")
            if !model.items.isEmpty || !pending.isEmpty {
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(Palette.muted)
                    TextField("Find a service", text: $search).textFieldStyle(.plain).accessibilityLabel("Find a service")
                    if !search.isEmpty { Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).accessibilityLabel("Clear search") }
                }.padding(.horizontal, 10).padding(.vertical, 6).background(Palette.card, in: RoundedRectangle(cornerRadius: 7)).overlay { RoundedRectangle(cornerRadius: 7).strokeBorder(Palette.line).allowsHitTesting(false) }
            }
            if !saved.isEmpty {
                StackCard {
                    ForEach(saved) { item in
                        if item.id != saved.first?.id { Divider() }
                        SubscriptionRow(item: item) { sheet = .edit(item) }
                    }
                }
            }
            if !matches.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Eyebrow(filter == .canceled ? "Cancellation notices · Needs review" :
                                filter == .active ? "Renewal notices · Needs review" : "From Gmail · Needs review")
                    Text(L10n.text(reviewHelp)).font(.caption).foregroundStyle(Palette.muted)
                }
                StackCard {
                    ForEach(matches) { candidate in
                        if candidate.id != matches.first?.id { Divider() }
                        Button { sheet = .scanCandidate(candidate) } label: {
                            HStack(spacing: 10) {
                                ServiceMark(name: candidate.name)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(candidate.name).font(.headline).lineLimit(2)
                                    Text(L10n.text(candidate.kind.label) + " · " + L10n.date(candidate.receivedAt))
                                        .font(.caption).foregroundStyle(Palette.muted)
                                }
                                Spacer(minLength: 6)
                                if let amount = candidate.draft.amount, let currency = candidate.draft.currency {
                                    Text(rateText(amount, currency, candidate.draft.cadence))
                                        .font(.callout).monospacedDigit().foregroundStyle(Palette.muted)
                                }
                                Text("Review").font(.callout.weight(.semibold)).foregroundStyle(Palette.tint)
                                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(Palette.muted)
                            }.padding(.horizontal, 12).padding(.vertical, 9).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityHint("Review this Gmail match")
                    }
                }
            }
            if saved.isEmpty && matches.isEmpty {
                Text(L10n.text(emptyMessage)).font(.callout).foregroundStyle(Palette.muted)
                    .padding(13).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.card, in: RoundedRectangle(cornerRadius: 9))
            }
        }
    }

    private var reviewHelp: String {
        switch filter {
        case .canceled: return "Gmail found a cancellation notice for each service below. Review it to confirm the status."
        case .active: return "These emails mention a renewal. Review the evidence to confirm whether the service is still active."
        case .all, .review: return "Choose a match to confirm its status or dismiss it."
        }
    }

    private func filterLabel(_ value: ServiceFilter) -> String {
        switch value {
        case .all: return value.rawValue
        case .active: return L10n.format("Renewing (%d)", model.items.filter { $0.status == .active }.count)
        case .canceled: return L10n.format("Renewal off (%d)", model.items.filter { $0.status != .active }.count)
        case .review: return L10n.format("Needs review (%d)", pending.count)
        }
    }

    private var emptyMessage: String {
        if !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "No services match this search and filter." }
        switch filter {
        case .active: return "No plans marked for renewal."
        case .canceled: return "No plans with renewal turned off."
        case .review: return scan.lastScanAt == nil ? "Scan Gmail to find subscriptions to review." : "No Gmail matches need review."
        case .all: return "Scan Gmail to discover subscriptions, or add a service manually."
        }
    }

    private func beginScan() {
        sheet = .scan
        scan.start()
    }

    private var alternativeEntries: some View {
        Menu {
            Button("Add manually…") { sheet = .add }.keyboardShortcut("n")
            Divider()
            Button("Import receipt file…", action: importReceipt)
            Button("Paste receipt text…") { sheet = .paste }
        } label: {
            Image(systemName: "ellipsis.circle").font(.system(size: 16)).padding(4)
        }
        .menuIndicator(.hidden).menuStyle(.borderlessButton).fixedSize()
        .accessibilityLabel("More ways to add").help("More ways to add")
    }

    private func importReceipt() {
        let panel = NSOpenPanel()
        panel.title = "Review a billing receipt"; panel.prompt = "Review receipt"
        panel.allowedContentTypes = [UTType(filenameExtension: "txt"), UTType(filenameExtension: "eml"), .pdf].compactMap { $0 }
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { sheet = .review(try model.importReceipt(url)) } catch { failure = error.localizedDescription }
    }
}

private struct ServicePayments: View {
    let summary: PaymentSummary
    let exclude: (RecordedPayment) throws -> Void
    @State private var expanded: Set<String> = []
    @State private var showAll = false
    @State private var exclusion: RecordedPayment?
    @State private var issue: String?

    private var visible: [ServiceSpending] {
        showAll ? summary.byService : Array(summary.byService.prefix(4))
    }

    var body: some View {
        StackCard {
            ForEach(visible, id: \.service) { group in
                if group.service != visible.first?.service { Divider() }
                DisclosureGroup(isExpanded: Binding(get: { expanded.contains(group.service) }, set: { open in
                    if open { expanded.insert(group.service) } else { expanded.remove(group.service) }
                })) {
                    ForEach(summary.payments.filter { $0.service.lowercased() == group.service.lowercased() }, id: \.id) { payment in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Label(Day.label(payment.day), systemImage: "calendar")
                                .font(.callout).monospacedDigit()
                            Text(L10n.text(payment.dateSource.label)).font(.caption).foregroundStyle(Palette.muted)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer()
                            Text(Ledger.displayMoney(payment.amount, payment.currency)).monospacedDigit()
                            Menu {
                                Button("Exclude payment…", role: .destructive) { exclusion = payment }
                            } label: {
                                Image(systemName: "ellipsis.circle").padding(2)
                            }.menuIndicator(.hidden).menuStyle(.borderlessButton).fixedSize()
                                .accessibilityLabel(L10n.format("Payment options for %@ on %@", payment.service, L10n.date(payment.day)))
                        }.padding(.vertical, 3)
                    }
                } label: {
                    HStack(alignment: .center) {
                        ServiceMark(name: group.service, size: 28)
                        Text(group.service).font(.headline).lineLimit(2)
                        Spacer()
                        VStack(alignment: .trailing, spacing: 1) {
                            ForEach(group.totals.keys.sorted(), id: \.self) { currency in
                                if let amount = group.totals[currency] {
                                    Text(Ledger.displayMoney(amount, currency)).font(.callout.weight(.semibold)).monospacedDigit()
                                }
                            }
                        }
                    }
                }.padding(.horizontal, 12).padding(.vertical, 8)
            }
            if summary.byService.count > 4 {
                Divider()
                Button(showAll ? L10n.text("Show fewer services") : L10n.format("Show all %d services", summary.byService.count)) { showAll.toggle() }
                    .buttonStyle(.link).padding(.horizontal, 12).padding(.vertical, 7)
            }
        }
        .alert("Exclude this payment?", isPresented: Binding(get: { exclusion != nil }, set: { if !$0 { exclusion = nil } }), presenting: exclusion) { payment in
            Button("Keep payment", role: .cancel) { }
            Button("Exclude payment", role: .destructive) {
                do { try exclude(payment) } catch { issue = error.localizedDescription }
            }
        } message: { payment in
            Text(L10n.format("%@ · %@ · %@. This payment will be removed from your spending history.", payment.service, Ledger.displayMoney(payment.amount, payment.currency), L10n.date(payment.day)))
        }
        .alert("Couldn’t exclude payment", isPresented: Binding(get: { issue != nil }, set: { if !$0 { issue = nil } })) {
            Button("OK") { issue = nil }
        } message: { Text(issue ?? "") }
    }

}

private struct RecurringEstimate: View {
    let items: [Subscription]
    var body: some View {
        let estimate = Ledger.spendingSummary(items)
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 4) {
                if estimate.monthlyByCurrency.isEmpty {
                    Text("No confirmed active plans with a complete rate.")
                } else {
                    ForEach(estimate.monthlyByCurrency.keys.sorted(), id: \.self) { currency in
                        if let monthly = estimate.monthlyByCurrency[currency], let annual = estimate.annualByCurrency[currency] {
                            Text(L10n.format("%@ / mo · %@ / yr", Ledger.displayMoney(monthly, currency), Ledger.displayMoney(annual, currency)))
                                .font(.callout.weight(.medium)).monospacedDigit()
                        }
                    }
                    Text("Based on the current rates of subscriptions marked active.")
                }
                if estimate.excludedActiveCount > 0 {
                    Text(L10n.format("%d active plans are missing their full rates.", estimate.excludedActiveCount))
                }
            }.font(.caption).foregroundStyle(Palette.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
        } label: {
            Text("Estimated recurring cost").font(.callout.weight(.medium))
        }
    }
}

private struct StackCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 10))
            .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.line).allowsHitTesting(false) }
    }
}

private func rateText(_ amount: Decimal?, _ currency: String, _ cadence: Cadence?) -> String {
    guard amount != nil else { return L10n.text("Price unknown") }
    let price = Ledger.displayMoney(amount, currency)
    switch cadence {
    case .monthly: return L10n.format("%@ / mo", price)
    case .annual: return L10n.format("%@ / yr", price)
    case nil: return L10n.format("%@ · cycle unknown", price)
    }
}

private struct SubscriptionRow: View {
    let item: Subscription
    let open: () -> Void

    private var eventDescription: String {
        let active = item.status == .active
        guard let date = active ? item.nextBilling : item.accessEnds else {
            return L10n.text(active ? "Next bill unknown" : "Access end unknown")
        }
        let today = Day.fromLocal(Date())
        let label: String
        if active { label = date < today ? "Review past bill" : "Next bill" }
        else { label = date < today ? "Access ended" : "Access ends" }
        let days = Int(date.timeIntervalSince(today) / 86_400)
        let distance: String
        switch days {
        case 0: distance = L10n.text("today")
        case 1: distance = L10n.text("tomorrow")
        case -1: distance = L10n.text("yesterday")
        case ..<0: distance = L10n.format("%d days ago", -days)
        default: distance = L10n.format("in %d days", days)
        }
        return L10n.text(label) + " · " + L10n.date(Day.toLocal(date)) + " · " + distance
    }

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .center, spacing: 7) {
                    ServiceMark(name: item.name, size: 30)
                    Text(item.name).font(.system(size: 15, weight: .semibold)).lineLimit(2)
                    Text(L10n.text(item.status == .active ? "Renewing" : "Renewal off")).font(.caption.weight(.medium)).foregroundStyle(item.status == .active ? Palette.tint : Palette.muted)
                        .padding(.horizontal, 5).padding(.vertical, 1).background(Palette.pale, in: Capsule())
                    Spacer(minLength: 5)
                    Text((item.status == .active || item.amount == nil ? "" : L10n.text("Last rate · ")) + rateText(item.amount, item.currency, item.cadence))
                        .font(.callout.weight(.semibold)).monospacedDigit()
                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(Palette.muted)
                }
                Text(eventDescription).font(.callout).foregroundStyle(Palette.muted)
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle"); Text(L10n.format("Verified by you %@", L10n.date(item.verifiedAt)))
                    if let days = item.reminderDays, item.status == .active || item.accessEnds != nil {
                        Text("·"); Image(systemName: "bell"); Text(days == 0 ? L10n.text("Same day") : L10n.format("%dd before", days))
                    }
                }.font(.caption).foregroundStyle(Palette.muted)
            }.padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityHint("Open subscription details and edit status")
    }
}

private struct ReviewDestinationView: View {
    @ObservedObject var model: AppModel
    let draft: ReceiptDraft
    @Environment(\.dismiss) private var dismiss
    @State private var selection = ""
    @State private var chosen = false
    private var target: Subscription? { model.items.first { $0.id.uuidString == selection } }

    var body: some View {
        if model.items.isEmpty || chosen {
            SubscriptionEditor(model: model, existing: target, draft: draft)
        } else {
            VStack(alignment: .leading, spacing: 13) {
                Eyebrow("Import receipt")
                Text("Which subscription is this for?").font(.title2.bold())
                Text("A new bill for an existing subscription can update its price and next billing date.").font(.callout).foregroundStyle(Palette.muted)
                Picker("Subscription", selection: $selection) {
                    Text("Choose…").tag("")
                    Text("Add a new subscription").tag("new")
                    Divider()
                    ForEach(model.items.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }) { item in
                        Text(L10n.format("Update %@ · %@", item.name, Ledger.displayMoney(item.amount, item.currency))).tag(item.id.uuidString)
                    }
                }
                HStack {
                    Spacer(); Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                    Button("Review details") { chosen = true }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(selection.isEmpty)
                }
            }.padding(22).frame(width: 445).foregroundStyle(Palette.ink).tint(Palette.tint).background(Palette.paper)
        }
    }
}

private struct PasteReceiptView: View {
    @ObservedObject var model: AppModel
    let review: (ReceiptDraft) -> Void
    @Environment(\.dismiss) var dismiss
    @State private var text = ""
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Eyebrow("Import receipt")
            Text("Paste billing text").font(.title2.bold())
            Text("Paste the relevant lines from a receipt. You’ll review the extracted details before saving.").font(.callout).foregroundStyle(Palette.muted)
            TextEditor(text: $text).font(.system(.body, design: .monospaced)).frame(height: 145).accessibilityLabel("Receipt text")
                .overlay { RoundedRectangle(cornerRadius: 4).strokeBorder(Palette.line) }
            if let error { Text(error).font(.callout).foregroundStyle(.red) }
            HStack {
                Spacer(); Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Review details") {
                    do { review(try model.importReceiptText(text)) } catch { self.error = error.localizedDescription }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(22).frame(width: 450).foregroundStyle(Palette.ink).tint(Palette.tint).background(Palette.paper)
    }
}

private struct PreferencesView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var options: PanelOptions
    @ObservedObject var scan: EmailScanController
    let switchAccount: () -> Void
    @Environment(\.dismiss) var dismiss
    @State private var busy = false
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            Text("Settings").font(.title2.bold())
            Picker("Language", selection: $options.language) {
                ForEach(AppLanguage.allCases) { language in Text(verbatim: language.label).tag(language) }
            }.pickerStyle(.menu).accessibilityLabel(L10n.text("Interface language"))
            Divider()
            Eyebrow("Gmail account")
            if let address = scan.connectedAddress {
                Text(address).font(.headline).textSelection(.enabled)
                HStack {
                    Button("Switch account", action: switchAccount)
                    Button("Disconnect from this Mac") { scan.disconnect() }
                }
                Text("Saved payments stay on this Mac after you disconnect. Reconnect the same account to see its payment history.")
                    .font(.caption).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                if case .failed(let message) = scan.phase {
                    Text(message).font(.caption).foregroundStyle(.red)
                }
            } else {
                Text("Choose an account the first time you scan Gmail.").font(.callout).foregroundStyle(Palette.muted)
            }
            Divider()
            Eyebrow("Quick access")
            LabeledContent("Global shortcut", value: options.shortcut)
            Text(L10n.text(options.shortcutHelp.isEmpty ? "Click the Dock icon, use the shortcut, or click the menu-bar calendar to open the window. Escape hides it." : options.shortcutHelp)).font(.callout).foregroundStyle(Palette.muted)
            HStack {
                Text("Open at login"); Spacer()
                Button(L10n.text(options.loginStatus == .enabled || options.loginStatus == .requiresApproval ? "Turn off" : "Turn on")) { Task { await options.toggleLogin() } }
            }
            if options.loginStatus == .requiresApproval { Button("Review Login Items in System Settings") { SMAppService.openSystemSettingsLoginItems() } }
            if let error = options.loginError { Text(error).font(.callout).foregroundStyle(.red) }
            Divider()
            Eyebrow("Local notifications")
            Text(model.permissionText).font(.headline)
            Text("Set a reminder on a subscription to get a macOS notification before its next renewal. The test button requests a single test alert.").font(.callout).foregroundStyle(Palette.muted)
            HStack {
                Button("Enable notifications") { run { await model.enableNotifications() } }
                Button("Test notification") { run { await model.testNotification() } }
            }.disabled(busy)
            if let notice = model.notice { Text(notice).font(.callout).textSelection(.enabled).foregroundStyle(Palette.muted) }
            Divider()
            HStack { Spacer(); Button("Done") { dismiss() }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction) }
        }.padding(24).frame(width: 440).foregroundStyle(Palette.ink).tint(Palette.tint).background(Palette.paper)
            .environment(\.locale, options.language.locale)
    }
    private func run(_ operation: @escaping @MainActor () async -> Void) {
        busy = true
        Task { await operation(); busy = false }
    }
}
