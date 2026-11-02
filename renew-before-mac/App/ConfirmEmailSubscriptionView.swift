import SwiftUI

/// A receipt can be a one-time purchase. The user confirms recurring billing and current status.
struct ConfirmEmailSubscriptionView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var scan: EmailScanController
    let candidate: MailCandidate
    @Environment(\.dismiss) private var dismiss
    @State private var details = false
    @State private var name: String
    @State private var amount: String
    @State private var currency: String
    @State private var cadence: Cadence?
    @State private var status: SubscriptionStatus?
    @State private var nextBilling: Date?
    @State private var checked = false
    @State private var issue: String?

    init(model: AppModel, scan: EmailScanController, candidate: MailCandidate) {
        self.model = model; self.scan = scan; self.candidate = candidate
        _name = State(initialValue: candidate.name)
        _amount = State(initialValue: candidate.draft.amount.map { NSDecimalNumber(decimal: $0).stringValue } ?? "")
        _currency = State(initialValue: candidate.draft.currency ?? "")
        _cadence = State(initialValue: candidate.draft.cadence)
        _nextBilling = State(initialValue: candidate.draft.nextBilling)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) { ServiceMark(name: name, size: 44); Text(verbatim: name).font(.title2.weight(.semibold)); Spacer() }
            if details {
                Text(L10n.text("Confirm the subscription details")).font(.title2.weight(.semibold))
                ScrollView {
                    VStack(alignment: .leading, spacing: 15) {
                        Text(L10n.text("Check the current account or original receipt. Leave anything you can’t confirm empty."))
                            .font(.callout).foregroundStyle(Palette.muted)
                        TextField(L10n.text("Service name"), text: $name).textFieldStyle(.roundedBorder)
                        HStack {
                            TextField(L10n.text("Recurring price"), text: $amount).textFieldStyle(.roundedBorder)
                            TextField(L10n.text("Currency, e.g. USD"), text: $currency).textFieldStyle(.roundedBorder).frame(width: 150)
                        }
                        Picker(L10n.text("Billing cycle"), selection: $cadence) {
                            Text(L10n.text("Not sure yet")).tag(Optional<Cadence>.none)
                            Text(L10n.text("Monthly")).tag(Optional(Cadence.monthly))
                            Text(L10n.text("Annual")).tag(Optional(Cadence.annual))
                        }
                        Picker(L10n.text("Current renewal status"), selection: $status) {
                            Text(L10n.text("Choose…")).tag(Optional<SubscriptionStatus>.none)
                            Text(L10n.text("Will renew")).tag(Optional(SubscriptionStatus.active))
                            Text(L10n.text("Renewal is off")).tag(Optional(SubscriptionStatus.notRenewing))
                            Text(L10n.text("Canceled")).tag(Optional(SubscriptionStatus.canceled))
                        }
                        if status == .active { OptionalDecisionDate(title: "Next billing date", value: $nextBilling) }
                        Toggle(L10n.text("I checked these details against my account or receipt."), isOn: $checked)
                            .font(.callout).fixedSize(horizontal: false, vertical: true)
                    }.padding(.vertical, 3)
                }.frame(maxHeight: 360)
                if let issue { Text(issue).font(.caption).foregroundStyle(.red) }
                HStack {
                    Button(L10n.text("Back")) { details = false }
                    Spacer()
                    Button(L10n.text("Add subscription"), action: save).buttonStyle(.borderedProminent).disabled(!checked || status == nil)
                }
            } else {
                Text(L10n.text("Is this one of your subscriptions?")).font(.system(size: 26, weight: .semibold, design: .rounded))
                Text(L10n.format("Email: %@ · %@", L10n.text(candidate.kind.label), L10n.date(candidate.receivedAt)))
                    .font(.callout).foregroundStyle(Palette.muted)
                if let amount = candidate.draft.amount {
                    Text(L10n.format("Email lists %@", Ledger.displayMoney(amount, candidate.draft.currency ?? ""))).font(.callout)
                }
                Text(L10n.text("A receipt or cancellation email doesn’t prove a subscription is active today. One-time purchases don’t belong in your recurring total."))
                    .foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                Button(L10n.text("Yes, review the details")) { details = true }.buttonStyle(.borderedProminent).controlSize(.large)
                Button(L10n.text("Not a subscription")) {
                    do { try scan.dismissMatch(candidate); dismiss() } catch { issue = error.localizedDescription }
                }.buttonStyle(.bordered).controlSize(.large)
                if let issue { Text(issue).font(.caption).foregroundStyle(.red) }
                HStack { Spacer(); Button(L10n.text("Decide later")) { dismiss() }.keyboardShortcut(.cancelAction) }
            }
        }.padding(24).frame(width: 450).foregroundStyle(Palette.ink).tint(Palette.tint).background(Palette.paper)
    }

    private func save() {
        do {
            let text = amount.trimmingCharacters(in: .whitespacesAndNewlines)
            let price = text.isEmpty ? nil : Decimal(string: text, locale: Locale(identifier: "en_US_POSIX"))
            guard text.isEmpty || price != nil else { throw RecordError("Enter a valid recurring price, or leave it empty.") }
            guard let status else { return }
            var item = Subscription(name: name, amount: price, currency: currency, cadence: cadence,
                                    nextBilling: status == .active ? nextBilling : nil,
                                    evidence: L10n.format("Gmail · %@", L10n.date(candidate.receivedAt)), receiptID: candidate.draft.receiptID)
            item.status = status
            if !item.renewing { item.renewalOffConfirmedAt = Date() }
            try model.save(item, verify: checked)
            dismiss()
        } catch { issue = error.localizedDescription }
    }
}
