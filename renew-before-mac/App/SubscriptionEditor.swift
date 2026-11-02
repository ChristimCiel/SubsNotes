import SwiftUI

extension SubscriptionStatus {
    var label: String {
        switch self {
        case .active: return L10n.text("Active")
        case .notRenewing: return L10n.text("Renewal off")
        case .canceled: return L10n.text("Canceled")
        }
    }
}

struct SubscriptionEditor: View {
    @ObservedObject var model: AppModel
    let existing: Subscription?
    let draft: ReceiptDraft?
    let scannedEmail: MailCandidate?
    var onFinish: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var amount: String
    @State private var currency: String
    @State private var cadence: Cadence?
    @State private var started: String
    @State private var nextBilling: String
    @State private var accessEnds: String
    @State private var evidence: String
    @State private var status: SubscriptionStatus?
    @State private var reminderDays: String
    @State private var verified = false
    @State private var problem: String?
    @State private var confirmDelete = false
    @State private var purpose: String
    @State private var needsUntil: Date?
    @State private var reviewOn: Date?
    @State private var isEssential: Bool
    @State private var cancelBy: Date?
    @State private var billingChannel: String

    init(model: AppModel, existing: Subscription? = nil, draft receipt: ReceiptDraft? = nil,
         scannedEmail: MailCandidate? = nil, sourceAddress: String? = nil, onFinish: (() -> Void)? = nil) {
        let draft = scannedEmail?.draft ?? receipt
        self.scannedEmail = scannedEmail
        self.onFinish = onFinish
        self.model = model
        self.existing = existing
        self.draft = draft
        let cycleChanged = draft?.cadence != nil && existing?.cadence != nil && draft?.cadence != existing?.cadence
        // A partial new price cannot borrow the currency or amount of an unrelated charge.
        let hasNoNewMoney = draft?.amount == nil && draft?.currency == nil
        let retainSavedMoney = draft == nil || (hasNoNewMoney && !cycleChanged)
        _name = State(initialValue: draft?.name ?? existing?.name ?? "")
        _amount = State(initialValue: (draft?.amount ?? (retainSavedMoney ? existing?.amount : nil)).map { NSDecimalNumber(decimal: $0).stringValue } ?? "")
        _currency = State(initialValue: draft?.currency ?? (retainSavedMoney ? existing?.currency : nil) ?? "")
        _cadence = State(initialValue: draft?.cadence ?? (retainSavedMoney ? existing?.cadence : nil))
        _started = State(initialValue: existing?.started.map(Day.label) ?? "")
        _nextBilling = State(initialValue: (draft?.nextBilling ?? existing?.nextBilling).map(Day.label) ?? "")
        _accessEnds = State(initialValue: existing?.accessEnds.map(Day.label) ?? "")
        let note = scannedEmail.map { message in
            let date = Day.label(Day.fromLocal(message.receivedAt))
            return sourceAddress.map { L10n.format("Gmail in %@ · %@", $0, date) } ?? L10n.format("Gmail · %@", date)
        }
        _evidence = State(initialValue: note ?? (draft == nil ? (existing?.evidence ?? "") : L10n.text("Imported receipt")))
        _status = State(initialValue: scannedEmail == nil ? existing?.status : nil)
        _reminderDays = State(initialValue: existing?.reminderDays.map(String.init) ?? "")
        _purpose = State(initialValue: existing?.purpose ?? "")
        _needsUntil = State(initialValue: existing?.needsUntil)
        _reviewOn = State(initialValue: existing?.reviewOn)
        _isEssential = State(initialValue: existing?.isEssential == true)
        _cancelBy = State(initialValue: existing?.cancelBy)
        _billingChannel = State(initialValue: existing?.billingChannel ?? "")
    }

    private var header: String { scannedEmail != nil ? L10n.text("Review subscription") : draft != nil ? L10n.text("Review receipt") : existing != nil ? L10n.text("Subscription details") : L10n.text("Add subscription") }
    private var savedSubhead: String {
        if let scannedEmail {
            let received = L10n.date(scannedEmail.receivedAt)
            return existing.map { L10n.format("Update %@ from the email received %@.", $0.name, received) }
                ?? L10n.format("Add a new subscription from the email received %@.", received)
        }
        if let existing, draft != nil { return L10n.format("Updating %@. Check each field before saving.", existing.name) }
        if let existing { return L10n.format("Last verified by you %@.", L10n.date(existing.verifiedAt, includeTime: true)) }
        return draft == nil ? L10n.text("Use a recent receipt or your billing settings.") : L10n.text("Check the details you can verify. Unknown prices and dates can stay blank.")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow("Renew Before")
                Text(header).font(.title2.bold()).accessibilityAddTraits(.isHeader)
                Text(savedSubhead).font(.callout).foregroundStyle(Palette.muted)
            }.padding(.horizontal, 22).padding(.vertical, 14)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 13) {
                    if let draft {
                        Eyebrow(scannedEmail == nil ? "Receipt excerpt" : "Email evidence")
                        if let scannedEmail {
                            Text(scannedEmail.subject.isEmpty ? scannedEmail.kind.label : scannedEmail.subject).font(.headline).textSelection(.enabled)
                            if !scannedEmail.sender.isEmpty {
                                Text(scannedEmail.sender).font(.caption).foregroundStyle(Palette.muted).textSelection(.enabled)
                            }
                        }
                        if !draft.excerpt.isEmpty {
                            ScrollView { Text(draft.excerpt).font(.system(.caption, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled) }
                                .frame(height: 80).padding(9).background(Palette.card, in: RoundedRectangle(cornerRadius: 7)).overlay { RoundedRectangle(cornerRadius: 7).strokeBorder(Palette.line) }
                        } else if scannedEmail != nil {
                            Text("This match was saved from an earlier scan. Check the original email in Gmail or the service’s billing page before confirming.")
                                .font(.callout).foregroundStyle(Palette.muted)
                        }
                    }
                    if let existing, draft != nil {
                        Text(L10n.format("Updating %@. Review the saved details alongside this receipt.", existing.name)).font(.callout).foregroundStyle(Palette.muted)
                    }
                    Eyebrow("Your plans for this service")
                    entry("What do you use it for?", hint: "e.g. Music for the launch video", text: $purpose)
                    Toggle("Essential to my work or daily life", isOn: $isEssential)
                        .font(.callout)
                    HStack(alignment: .top, spacing: 15) {
                        OptionalDecisionDate(title: "Need it until", value: $needsUntil)
                        OptionalDecisionDate(title: "Review on", value: $reviewOn)
                    }
                    Text("A project date can bring your review forward. A known earlier billing decision still takes priority.")
                        .font(.caption).foregroundStyle(Palette.muted)
                    Divider()
                    Eyebrow("Billing details")
                    entry("Service name", hint: "e.g. Acme Cloud", text: $name)
                    statusChooser
                    Picker("Purchased through", selection: $billingChannel) {
                        Text("Unknown").tag("")
                        Text("Service website").tag("website")
                        Text("Apple App Store").tag("apple")
                        Text("Google Play").tag("googlePlay")
                    }
                    Text("Check the original purchase channel. It determines where you manage renewal.")
                        .font(.caption).foregroundStyle(Palette.muted)
                    HStack(alignment: .top, spacing: 10) {
                        entry("Billing amount", hint: "e.g. 12.99", text: $amount)
                        entry("Currency", hint: "e.g. USD", text: $currency).frame(width: 88)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Billing cycle").font(.caption.weight(.medium))
                            Picker("Billing cycle", selection: $cadence) {
                                Text("Unknown").tag(Cadence?.none)
                                Text("Monthly").tag(Cadence?.some(.monthly))
                                Text("Annual").tag(Cadence?.some(.annual))
                            }.labelsHidden().frame(width: 114)
                        }
                    }
                    Text("Leave unknown prices blank. Spending estimates include active services with a known amount, currency and cycle.").font(.caption).foregroundStyle(Palette.muted)
                    Divider()
                    Eyebrow("Subscription dates")
                    Text("Leave dates blank if unknown. Enter dates as YYYY-MM-DD.").font(.caption).foregroundStyle(Palette.muted)
                    HStack(alignment: .top, spacing: 10) {
                        if status == nil || status == .active {
                            entry("Next billing date", hint: "YYYY-MM-DD", text: $nextBilling)
                        }
                        entry("Access ends", hint: "YYYY-MM-DD", text: $accessEnds)
                        entry("Started", hint: "YYYY-MM-DD", text: $started)
                    }
                    if let day = Day.parse(started), let status, status == .active || Day.parse(accessEnds) != nil {
                        let today = Day.fromLocal(Date())
                        let end = status == .active ? today : min(today, Day.parse(accessEnds) ?? today)
                        if end >= day {
                            let elapsed = Calendar(identifier: .gregorian).dateComponents([.year, .month, .day], from: Day.toLocal(day), to: Day.toLocal(end))
                            let words = [(elapsed.year, "%lld year", "%lld years"), (elapsed.month, "%lld month", "%lld months"), (elapsed.day, "%lld day", "%lld days")].compactMap { count, singular, plural -> String? in
                                guard let count, count > 0 else { return nil }
                                return L10n.format(count == 1 ? singular : plural, count)
                            }
                            Text(L10n.format("Duration from recorded start: %@.", words.isEmpty ? L10n.text("0 days") : words.joined(separator: L10n.text(", ")))).font(.caption).foregroundStyle(Palette.muted)
                        }
                    }
                    OptionalDecisionDate(title: "Verified cancel-by date", value: $cancelBy)
                    Text("Only enter a cancellation deadline you have checked with the provider. Leave it unknown if you are unsure.")
                        .font(.caption).foregroundStyle(Palette.muted)
                    Divider()
                    Eyebrow("Reminder")
                    if let status {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            TextField("Off", text: $reminderDays).accessibilityLabel("Reminder days").frame(width: 60)
                            Text(status == .active ? L10n.text("days before the next bill") : L10n.text("days before access ends")).font(.callout)
                        }
                        Text("Leave blank for off. Use 0 for the bill or access-end day. Project and chosen review dates can bring the reminder forward. Notifications use 9 AM local time and need macOS permission.").font(.caption).foregroundStyle(Palette.muted)
                    } else {
                        Text("Choose a subscription status to set a reminder.").font(.caption).foregroundStyle(Palette.muted)
                    }
                    Divider()
                    Eyebrow("Source and verification")
                    entry("Source note", hint: "e.g. Billing page checked on November 1", text: $evidence)
                    if draft != nil { Text("The source note is saved with the record. You can edit it to identify the billing email or receipt.").font(.caption).foregroundStyle(Palette.muted) }
                }.padding(.horizontal, 22).padding(.vertical, 15)
            }
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Toggle("I checked the status and details shown against my records.", isOn: $verified)
                if let existing, draft == nil, !verified {
                    Text(L10n.format("Changes to your purpose, project, review date or reminder keep the %@ billing verification date.", L10n.date(existing.verifiedAt))).font(.caption).foregroundStyle(Palette.muted)
                }
                if let problem { Label(problem, systemImage: "exclamationmark.circle").font(.callout).foregroundStyle(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                HStack {
                    if existing != nil && draft == nil { Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: "trash") } }
                    Spacer()
                    Button("Cancel") { finish() }.keyboardShortcut(.cancelAction)
                    Button(scannedEmail != nil ? L10n.text("Save subscription") : draft != nil ? L10n.text("Save reviewed receipt") : existing == nil ? L10n.text("Save subscription") : L10n.text("Save changes"), action: save).buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                }
            }.padding(.horizontal, 22).padding(.vertical, 12)
        }.frame(width: 475, height: min(620, (NSScreen.main?.visibleFrame.height ?? 800) - 90)).foregroundStyle(Palette.ink).tint(Palette.tint).background(Palette.paper)
        .alert("Delete this subscription?", isPresented: $confirmDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                guard let existing else { return }
                do { try model.remove(existing.id); finish() } catch { problem = error.localizedDescription }
            }
        } message: { Text(L10n.format("This removes %@ from this Mac and clears its pending renewal reminder.", existing?.name ?? L10n.text("the subscription"))) }
    }

    private func entry(_ label: String, hint: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L10n.text(label)).font(.caption.weight(.medium))
            TextField(L10n.text(hint), text: text).textFieldStyle(.roundedBorder).accessibilityLabel(L10n.text(label))
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var statusChooser: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Subscription status").font(.caption.weight(.medium))
            HStack {
                ForEach(SubscriptionStatus.allCases, id: \.self) { choice in
                    Button {
                        let previous = status ?? existing?.status
                        if let previous, (choice == .active) != (previous == .active) {
                            // An old billing alert should not silently turn into an access-end alert.
                            reminderDays = ""
                            if choice == .active && draft?.nextBilling == nil { nextBilling = "" }
                        }
                        status = choice
                        problem = nil
                    } label: {
                        Label(choice.label, systemImage: status == choice ? "checkmark.circle.fill" : "circle")
                    }
                    .accessibilityValue(status == choice ? L10n.text("Selected") : L10n.text("Unselected"))
                }
            }
            switch status {
            case .active:
                Text("You expect this service to bill again.")
            case .notRenewing:
                Text("Automatic renewal is off. You can track when access ends.")
            case .canceled:
                Text("You’ve confirmed cancellation with the provider. The dashboard keeps this record and excludes it from spending estimates.")
            case nil:
                Text(existing.map { L10n.format("Previously recorded as %@. Choose its current status.", $0.status.label.lowercased()) }
                     ?? L10n.text("Choose the current status from your billing settings or a confirmation email."))
            }
        }
        .font(.caption).foregroundStyle(Palette.muted)
    }

    private func finish() {
        if let onFinish { onFinish() } else { dismiss() }
    }

    private func save() {
        guard let status else {
            problem = L10n.text("Choose the current subscription status.")
            return
        }
        let cleanAmount = amount.trimmingCharacters(in: .whitespacesAndNewlines)
        var price: Decimal?
        if !cleanAmount.isEmpty {
            guard cleanAmount.range(of: #"^[0-9]+(?:\.[0-9]+)?$"#, options: .regularExpression) != nil,
                  let parsed = Decimal(string: cleanAmount, locale: Locale(identifier: "en_US_POSIX")) else {
                problem = L10n.text("Enter an amount such as 12.99, or leave it blank.")
                return
            }
            price = parsed
        }
        let nextBill = status == .active ? nextBilling : ""
        let dates = [("next billing date", nextBill), ("access end date", accessEnds), ("start date", started)].map { ($0.0, $0.1.trimmingCharacters(in: .whitespacesAndNewlines)) }
        for (label, text) in dates where !text.isEmpty && Day.parse(text) == nil { problem = L10n.format("Enter a valid %@ as YYYY-MM-DD, or leave it blank.", L10n.text(label)); return }
        let lead = reminderDays.trimmingCharacters(in: .whitespacesAndNewlines)
        let days = Int(lead)
        if !lead.isEmpty && (days == nil || !(0...365).contains(days!)) { problem = L10n.text("Enter a reminder from 0 to 365 days, or leave it blank."); return }
        var item = existing ?? Subscription()
        item.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        item.amount = price; item.currency = currency.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(); item.cadence = cadence
        // Preserve legacy records on reminder-only edits. New cancellations have no next charge.
        if status == .active || existing?.status != status { item.nextBilling = Day.parse(dates[0].1) }
        item.accessEnds = Day.parse(dates[1].1); item.started = Day.parse(dates[2].1)
        item.evidence = evidence.trimmingCharacters(in: .whitespacesAndNewlines); item.status = status; item.reminderDays = days
        item.receiptID = draft?.receiptID ?? existing?.receiptID
        item.purpose = purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        item.needsUntil = needsUntil
        item.reviewOn = reviewOn
        item.isEssential = isEssential
        item.cancelBy = cancelBy
        item.billingChannel = billingChannel.isEmpty ? nil : billingChannel
        if draft != nil && !verified { problem = L10n.text("Review and confirm these billing details before saving."); return }
        if let error = Ledger.validate(item) { problem = error; return }
        if item.reminderDays != nil && (item.renewing ? item.nextBilling : item.accessEnds) == nil && item.needsUntil == nil && item.reviewOn == nil && item.cancelBy == nil { problem = L10n.text("Add the date for this reminder or leave the reminder blank."); return }
        do { try model.save(item, verify: verified); finish() } catch { problem = error.localizedDescription }
    }
}
