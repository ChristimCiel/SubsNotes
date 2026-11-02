import AppKit
import SwiftUI

struct SubscriptionHomeView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var scan: EmailScanController
    let review: (Subscription) -> Void
    let reviewEmail: (MailCandidate) -> Void
    let add: () -> Void
    @State private var showMatches = false

    private var matches: [MailCandidate] { scan.pending(for: model.items).filter { $0.kind != .paymentProblem } }
    private var problems: [MailCandidate] { scan.pending(for: model.items).filter { $0.kind == .paymentProblem } }
    private var next: Subscription? { SubscriptionActions.nextToReview(model.items) }
    private var sorted: [Subscription] {
        model.items.sorted {
            if $0.renewing != $1.renewing { return $0.renewing }
            return ($0.nextBilling ?? .distantFuture) < ($1.nextBilling ?? .distantFuture)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text(L10n.text("Your subscriptions")).font(.system(size: 30, weight: .semibold, design: .rounded)).accessibilityAddTraits(.isHeader)
            if model.items.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Image(systemName: "square.stack.3d.up").font(.system(size: 28)).foregroundStyle(Palette.tint).accessibilityHidden(true)
                    Text(L10n.text("Let’s build your subscription list.")).font(.title2.weight(.semibold))
                    Text(L10n.text(matches.isEmpty ? "Add a subscription, or scan Gmail to find your billing emails." : "Your email matches are ready. Confirm which are subscriptions; some may be one-time purchases."))
                        .foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    if let first = matches.first {
                        Button(L10n.text("Confirm your first subscription")) { reviewEmail(first) }.buttonStyle(.borderedProminent).controlSize(.large)
                    } else { Button(L10n.text("Add a subscription"), action: add).buttonStyle(.borderedProminent).controlSize(.large) }
                    Text(L10n.text("Your monthly total appears after you confirm a subscription’s price and billing cycle."))
                        .font(.caption).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }.consumerSurface()
            } else {
                monthlySummary
                if let next {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(DecisionPlan.make(next).dueOn.map { L10n.format("Review by %@", L10n.date(Day.toLocal($0))) } ?? L10n.text("NEXT TO REVIEW"))
                            .font(.caption.weight(.semibold)).foregroundStyle(Palette.tint)
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 16) { featuredService(next); reviewButton(next) }
                            VStack(alignment: .leading, spacing: 12) { featuredService(next); reviewButton(next) }
                        }
                    }.consumerSurface()
                } else if !model.items.filter(\.renewing).isEmpty {
                    Label(L10n.text("Your upcoming renewals are reviewed."), systemImage: "checkmark.circle").foregroundStyle(Palette.tint)
                }
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(L10n.text(next == nil ? "Your subscriptions" : "Your other subscriptions")).font(.headline)
                        Spacer()
                        Button(action: add) { Label(L10n.text("Add"), systemImage: "plus") }.buttonStyle(.borderless)
                    }
                    ForEach(sorted.filter { $0.id != next?.id }) { item in
                        Button { review(item) } label: {
                            HStack(spacing: 12) {
                                ServiceMark(name: item.name, size: 37)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(verbatim: item.name).font(.headline).foregroundStyle(Palette.ink)
                                    Text(serviceStatus(item)).font(.caption).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                                }
                                Spacer(minLength: 8)
                                Text(item.renewing ? serviceRate(item) : L10n.text("Off"))
                                    .font(.callout.weight(.medium)).monospacedDigit().foregroundStyle(Palette.ink).multilineTextAlignment(.trailing)
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Palette.muted).accessibilityHidden(true)
                            }.padding(.vertical, 12).frame(maxWidth: .infinity, minHeight: 52).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityLabel(L10n.format("Review %@", item.name))
                            .accessibilityValue(serviceStatus(item) + " · " + (item.renewing ? serviceRate(item) : L10n.text("Off")))
                        Divider()
                    }
                }
            }
            if let first = problems.first {
                Button { reviewEmail(first) } label: {
                    Label(L10n.format("Check a payment problem for %@", first.name), systemImage: "exclamationmark.triangle")
                        .font(.callout.weight(.medium)).frame(maxWidth: .infinity, alignment: .leading).padding(13)
                }.buttonStyle(.plain).background(Palette.pale, in: RoundedRectangle(cornerRadius: 12))
            }
            if !matches.isEmpty {
                DisclosureGroup(isExpanded: $showMatches) {
                    Text(L10n.text("These are email matches, not confirmed subscriptions. Review them before adding them to your list."))
                        .font(.caption).foregroundStyle(Palette.muted).padding(.vertical, 8)
                    ForEach(matches) { match in
                        Button { reviewEmail(match) } label: {
                            HStack(spacing: 10) {
                                ServiceMark(name: match.name, size: 32)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(verbatim: match.name).foregroundStyle(Palette.ink)
                                    Text(L10n.text(match.kind.label)).font(.caption).foregroundStyle(Palette.muted)
                                }
                                Spacer(); Text(L10n.text("Confirm")).font(.callout).foregroundStyle(Palette.tint)
                            }.padding(.vertical, 8).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                } label: { Text(L10n.format("Found in your email (%d)", matches.count)).font(.callout.weight(.medium)) }
            }
        }
    }

    private var monthlySummary: some View {
        let summary = Ledger.spendingSummary(model.items)
        return VStack(alignment: .leading, spacing: 7) {
            if summary.monthlyByCurrency.isEmpty {
                Text(L10n.text(model.items.contains(where: \.renewing) ? "Monthly total needs a price" : "No subscriptions set to renew"))
                    .font(.title2.weight(.medium))
            } else {
                ForEach(summary.monthlyByCurrency.keys.sorted(), id: \.self) { currency in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text(Ledger.displayMoney(summary.monthlyByCurrency[currency], currency)).font(.system(size: 39, weight: .medium, design: .rounded)).monospacedDigit().minimumScaleFactor(0.65)
                        Text(L10n.text("/ month")).font(.callout).foregroundStyle(Palette.muted)
                    }
                }
                Text(L10n.text("Monthly total for subscriptions set to renew. Annual plans are spread over 12 months."))
                    .font(.caption).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            if summary.excludedActiveCount > 0 {
                Text(L10n.format("%d subscriptions need a price, currency, or billing cycle before they can be included.", summary.excludedActiveCount))
                    .font(.caption).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func reviewButton(_ item: Subscription) -> some View {
        Button { review(item) } label: { Label(L10n.format("Review %@", item.name), systemImage: "arrow.right") }
            .buttonStyle(.borderedProminent).controlSize(.large)
    }

    private func featuredService(_ item: Subscription) -> some View {
        HStack(spacing: 12) {
            ServiceMark(name: item.name, size: 43)
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: item.name).font(.headline)
                Text(billingLine(item)).font(.callout).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }
}

private func billingLine(_ item: Subscription) -> String {
    guard let day = item.nextBilling else { return L10n.text("Next billing date needs checking") }
    if day < Day.fromLocal(Date()) { return L10n.format("Recorded billing date %@ has passed. Check your account.", L10n.date(Day.toLocal(day))) }
    return L10n.format("%@ on %@", Ledger.displayMoney(item.amount, item.currency), L10n.date(Day.toLocal(day)))
}

private func serviceRate(_ item: Subscription) -> String {
    let rate = Ledger.displayMoney(item.amount, item.currency)
    guard let cadence = item.cadence else { return rate + " · " + L10n.text("Cycle unknown") }
    return rate + L10n.text(cadence == .monthly ? " / month" : " / year")
}

private func serviceStatus(_ item: Subscription) -> String {
    if !item.renewing { return L10n.text("Renewal off") }
    if let review = item.reviewOn, item.reminderDays != nil, DecisionPlan.make(item).needsReview {
        return L10n.format("Reminder %@", L10n.date(Day.toLocal(DecisionPlan.make(item).dueOn ?? review)))
    }
    if !DecisionPlan.make(item).needsReview { return L10n.text("Keeping this billing period") }
    if let day = item.nextBilling, day < Day.fromLocal(Date()) { return L10n.text("Date needs checking") }
    return item.nextBilling.map { L10n.format("Renews %@", L10n.date(Day.toLocal($0))) } ?? L10n.text("Date needs checking")
}

private extension View {
    func consumerSurface() -> some View {
        padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 16))
            .overlay { RoundedRectangle(cornerRadius: 16).strokeBorder(Palette.line).allowsHitTesting(false) }
    }
}

struct SubscriptionReviewView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var scan: EmailScanController
    let id: UUID
    let back: () -> Void
    let edit: (Subscription) -> Void
    // Injected only by the isolated QA host; the installed app opens the real website.
    var openWebsite: (URL) -> Bool = { NSWorkspace.shared.open($0) }
    @State private var step = "review"
    @State private var result = ""
    @State private var reminderChoice = 3
    @State private var reminderDate = Calendar.current.date(byAdding: .day, value: 1, to: Date())!
    @State private var planned: ReminderPlan?
    @State private var busy = false
    @State private var issue: String?
    @State private var previousTotals: [String: Decimal] = [:]
    private var item: Subscription? { model.items.first { $0.id == id } }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            if step != "success" {
                Button { if step == "review" { back() } else { step = step == "confirm" ? "stop" : "review" } } label: {
                    Label(L10n.text(step == "review" ? "Subscriptions" : "Back"), systemImage: "arrow.left")
                }.buttonStyle(.plain).foregroundStyle(Palette.muted).padding(.vertical, 6)
            }
            if let item {
                if step != "success" {
                    HStack(spacing: 12) {
                        ServiceMark(name: item.name, size: 44)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(verbatim: item.name).font(.headline)
                            Text(serviceRate(item)).font(.callout).foregroundStyle(Palette.muted)
                        }
                    }
                }
                switch step {
                case "stop": stop(item)
                case "confirm": confirmation(item)
                case "remind": reminder(item)
                case "success": success(item)
                default: review(item)
                }
                if let issue { Text(issue).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.updatesFrequently) }
            } else {
                Text(L10n.text("This subscription is no longer in your list."))
                Button(L10n.text("Back to subscriptions"), action: back)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func review(_ item: Subscription) -> some View {
        if !item.renewing {
            heading("Renewal is marked as off.")
            Text(L10n.text("This service is excluded from your monthly renewal total. Your previous payments stay in Payments.")).foregroundStyle(Palette.muted)
            if let checked = item.renewalOffConfirmedAt { Text(L10n.format("Confirmed by you %@", L10n.date(checked))).font(.caption).foregroundStyle(Palette.muted) }
            if let access = item.accessEnds { Text(L10n.format("Recorded access end: %@", L10n.date(Day.toLocal(access)))) }
            else { Text(L10n.text("Check the provider for your access end date.")).font(.callout).foregroundStyle(Palette.muted) }
        } else {
            let canKeep = DecisionPlan.make(item).kind != .verify
            Text(L10n.format("Still need %@ for the next billing period?", item.name)).font(.system(size: 29, weight: .semibold, design: .rounded)).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            Label(billingLine(item), systemImage: "calendar").font(.callout).consumerSurface()
            if !canKeep {
                Text(L10n.text("Check your billing date first so we can remind you at the right time.")).font(.callout).foregroundStyle(Palette.muted)
                Button(L10n.text("Update billing details")) { edit(item) }.buttonStyle(.borderedProminent).controlSize(.large)
            }
            HStack(spacing: 12) {
                Button(L10n.format("Keep %@", item.name)) { perform { try model.keepSubscription(id); result = "keep"; step = "success" } }
                    .disabled(!canKeep)
                Button(L10n.text("Stop renewing")) { issue = nil; step = "stop" }
            }.buttonStyle(.bordered).controlSize(.large)
            Button { issue = nil; step = "remind" } label: { Label(L10n.text("Not sure? Set a reminder"), systemImage: "bell") }.buttonStyle(.link)
        }
        Text(L10n.format("Billing last checked %@", L10n.date(item.verifiedAt))).font(.caption).foregroundStyle(Palette.muted)
        DisclosureGroup(L10n.text("See details and past payments")) {
            VStack(alignment: .leading, spacing: 12) {
                if let purpose = item.purpose { LabeledContent(L10n.text("Purpose"), value: purpose) }
                if let started = item.started { LabeledContent(L10n.text("Subscribed since"), value: L10n.date(Day.toLocal(started))) }
                let payments = scan.payments.filter { $0.service.localizedCaseInsensitiveCompare(item.name) == .orderedSame }
                let summary = PaymentSummary(payments: payments, period: .all)
                if summary.totals.isEmpty { Text(L10n.text("No recorded payments matched this service name.")) }
                ForEach(summary.totals.keys.sorted(), id: \.self) { currency in
                    LabeledContent(L10n.text("Recorded payments"), value: Ledger.displayMoney(summary.totals[currency], currency))
                }
                Text(L10n.text("Receipt history may be incomplete. Usage tracking is not connected, so a cost per hour is unavailable."))
                    .font(.caption).foregroundStyle(Palette.muted)
                if !item.evidence.isEmpty { Text(verbatim: item.evidence).font(.caption).foregroundStyle(Palette.muted).textSelection(.enabled) }
                Button(L10n.text("Edit billing details and project dates")) { edit(item) }
            }.font(.callout).padding(.top, 10)
        }.padding(.top, 10)
    }

    private func stop(_ item: Subscription) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(L10n.format("Turn off %@ renewal.", item.name)).font(.system(size: 29, weight: .semibold, design: .rounded)).accessibilityAddTraits(.isHeader)
            Text(L10n.text("You’ll do this where you bought the subscription.")).foregroundStyle(Palette.muted)
            instruction(1, "Open your billing settings", "Find the option to cancel or turn off renewal, then follow the provider’s instructions.")
            instruction(2, "Come back and confirm", "We’ll update your list after you tell us renewal is off.")
            if let destination = billingWebsite(item) {
                Button {
                    guard openWebsite(destination) else { issue = L10n.text("Couldn’t open the website. Open your account in a browser, then come back here."); return }
                    issue = nil; step = "confirm"
                } label: { Label(L10n.text("Open billing website"), systemImage: "arrow.up.right") }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                Text(destination.host ?? "").font(.caption).foregroundStyle(Palette.muted)
                if item.billingChannel == nil { Text(L10n.text("Bought through Apple or Google Play? Open subscriptions in that store instead.")).font(.caption).foregroundStyle(Palette.muted) }
            } else {
                Text(L10n.text("Open the service’s account or the app store where you subscribed. We don’t have a billing link for this service yet."))
                    .font(.callout).foregroundStyle(Palette.muted)
            }
            Button(L10n.text("I’ve checked the billing page")) { issue = nil; step = "confirm" }.buttonStyle(.bordered).controlSize(.large)
            Text(L10n.text("Opening a website does not cancel your subscription.")).font(.caption).foregroundStyle(Palette.muted)
        }
    }

    private func confirmation(_ item: Subscription) -> some View {
        VStack(alignment: .leading, spacing: 22) {
            Text(L10n.format("Did you turn off renewal in %@?", item.name)).font(.system(size: 29, weight: .semibold, design: .rounded)).accessibilityAddTraits(.isHeader)
            Text(L10n.text("Check the provider’s confirmation before marking it as done here.")).foregroundStyle(Palette.muted)
            Button(L10n.text("Yes, renewal is off")) {
                perform { previousTotals = Ledger.monthlyTotals(model.items); try model.confirmRenewalOff(id); result = "off"; step = "success" }
            }.buttonStyle(.borderedProminent).controlSize(.large)
            Button(L10n.text("Not yet — show me the steps")) { step = "stop" }.buttonStyle(.bordered).controlSize(.large)
            Text(L10n.text("This records your confirmation. Renew Before cannot change the provider’s billing settings."))
                .font(.caption).foregroundStyle(Palette.muted)
        }
    }

    private func reminder(_ item: Subscription) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            heading("When should we remind you?")
            if let bill = item.nextBilling { Text(billingLine(item)).foregroundStyle(Palette.muted); if bill <= Day.fromLocal(Date()) { Text(L10n.text("Update the billing date before setting a renewal reminder.")).foregroundStyle(Palette.muted) } }
            Picker(L10n.text("Remind me"), selection: $reminderChoice) {
                if let bill = item.nextBilling {
                    Text(L10n.format("3 days before · %@", L10n.date(Day.toLocal(bill.addingTimeInterval(-3 * 86400))))).tag(3)
                    Text(L10n.format("1 day before · %@", L10n.date(Day.toLocal(bill.addingTimeInterval(-86400))))).tag(1)
                }
                Text(L10n.text("Choose a date")).tag(0)
            }.pickerStyle(.menu).onAppear { if item.nextBilling == nil { reminderChoice = 0 } }
            if reminderChoice == 0 {
                DatePicker(L10n.text("Reminder date"), selection: $reminderDate, in: Date()..., displayedComponents: .date).datePickerStyle(.field)
            }
            Button(L10n.text(busy ? "Saving…" : "Set reminder")) {
                busy = true; issue = nil
                Task { @MainActor in
                    do {
                        let chosen = reminderChoice == 0 ? Day.fromLocal(reminderDate) : item.nextBilling!.addingTimeInterval(Double(-reminderChoice) * 86400)
                        planned = try await model.remindSubscription(id, on: chosen)
                        result = "reminder"; step = "success"
                    } catch { issue = error.localizedDescription }
                    busy = false
                }
            }.buttonStyle(.borderedProminent).controlSize(.large).disabled(busy)
            Text(L10n.text("Reminders are local macOS notifications, normally at 9 AM. Your Mac’s notification settings control whether a banner appears."))
                .font(.caption).foregroundStyle(Palette.muted)
        }
    }

    private func success(_ item: Subscription) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Image(systemName: result == "reminder" ? "bell.badge" : "checkmark.circle.fill").font(.system(size: 40)).foregroundStyle(Palette.tint).accessibilityHidden(true)
            Text(result == "off" ? L10n.format("%@ is off your renewal list.", item.name) : result == "keep" ? L10n.format("You’re keeping %@.", item.name) : L10n.text("Your reminder is saved."))
                .font(.system(size: 29, weight: .semibold, design: .rounded)).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            if result == "off" {
                Text(L10n.text("Your previous payments stay in your history.")).foregroundStyle(Palette.muted)
                let totals = Ledger.monthlyTotals(model.items)
                ForEach(previousTotals.keys.sorted(), id: \.self) { currency in
                    if previousTotals[currency] != totals[currency] {
                        Text(L10n.format("Monthly total: %@ → %@", Ledger.displayMoney(previousTotals[currency], currency), Ledger.displayMoney(totals[currency] ?? 0, currency))).font(.title3.weight(.medium)).monospacedDigit()
                    }
                }
            } else if result == "keep" {
                Text(L10n.text("This renewal is reviewed. Your provider’s billing settings are unchanged.")).foregroundStyle(Palette.muted)
            } else if let planned {
                Label(L10n.date(planned.fireAt, includeTime: true), systemImage: "calendar").font(.title3)
                Text(model.permissionText).font(.callout).foregroundStyle(Palette.muted)
                if !model.permissionText.hasPrefix(L10n.text("Allowed")) {
                    Text(L10n.text("Enable notifications to receive this reminder. Your saved reminder stays in the app.")).font(.callout).foregroundStyle(Palette.muted)
                    Button(L10n.text("Enable notifications")) { Task { await model.enableNotifications() } }
                }
            }
            Button(L10n.text("Back to subscriptions"), action: back).buttonStyle(.borderedProminent).controlSize(.large).keyboardShortcut(.defaultAction)
        }.padding(.top, 14)
    }

    private func heading(_ key: String) -> some View {
        Text(L10n.text(key)).font(.system(size: 29, weight: .semibold, design: .rounded)).accessibilityAddTraits(.isHeader)
    }
    private func instruction(_ n: Int, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(String(n)).font(.callout.weight(.semibold)).frame(width: 28, height: 28).background(Palette.pale, in: Circle())
            VStack(alignment: .leading, spacing: 5) { Text(L10n.text(title)).font(.headline); Text(L10n.text(detail)).font(.callout).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true) }
        }
    }
    private func perform(_ work: () throws -> Void) {
        issue = nil
        do { try work() } catch { issue = error.localizedDescription }
    }
}

private func billingWebsite(_ item: Subscription) -> URL? {
    if item.billingChannel == "apple" { return URL(string: "https://apps.apple.com/account/subscriptions") }
    if item.billingChannel == "googlePlay" { return URL(string: "https://play.google.com/store/account/subscriptions") }
    let name = item.name.lowercased()
    // Trusted homepages only; never open URLs extracted from an email.
    if name.hasPrefix("suno") { return URL(string: "https://suno.com/account") }
    if name.hasPrefix("chatgpt") || name == "openai" { return URL(string: "https://chatgpt.com/") }
    if name.hasPrefix("claude") || name == "anthropic" { return URL(string: "https://claude.ai/") }
    if name.hasPrefix("github") { return URL(string: "https://github.com/") }
    return nil
}
