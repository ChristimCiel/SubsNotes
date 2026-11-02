import SwiftUI

struct DecisionsView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var scan: EmailScanController
    let edit: (Subscription) -> Void
    let reviewEmail: (MailCandidate) -> Void
    let add: () -> Void
    @State private var planning: Subscription?
    @State private var confirmingProblem: MailCandidate?
    @State private var issue: String?

    private let warning = Color(nsColor: .systemOrange)
    private let urgent = Color(nsColor: .systemRed)

    private var problems: [MailCandidate] {
        scan.pending(for: model.items).filter { $0.kind == .paymentProblem }.sorted { left, right in
            let leftEssential = model.items.contains { $0.isEssential == true && $0.name.localizedCaseInsensitiveCompare(left.name) == .orderedSame }
            let rightEssential = model.items.contains { $0.isEssential == true && $0.name.localizedCaseInsensitiveCompare(right.name) == .orderedSame }
            return leftEssential != rightEssential ? leftEssential : left.receivedAt > right.receivedAt
        }
    }

    private var decisions: [(Subscription, DecisionPlan)] {
        model.items.map { ($0, DecisionPlan.make($0)) }.filter { $0.1.needsReview }.sorted {
            let left = $0.1.dueOn ?? .distantFuture
            let right = $1.1.dueOn ?? .distantFuture
            if left != right { return left < right }
            return $0.0.name.localizedStandardCompare($1.0.name) == .orderedAscending
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .firstTextBaseline) {
                Text("Your next decisions").font(.system(size: 23, weight: .semibold, design: .rounded))
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 4)
                Image(systemName: "leaf.fill").font(.title3).foregroundStyle(Palette.tint).accessibilityHidden(true)
            }
            HStack(spacing: 0) {
                overviewCount(model.items.count, title: "Saved plans", icon: "square.stack.3d.up", color: Palette.tint)
                Divider().frame(height: 31).padding(.horizontal, 10)
                overviewCount(decisions.count + scan.pending(for: model.items).filter { $0.kind != .paymentProblem }.count + scan.paymentReviews.count + scan.currencyReviews.count,
                              title: "Open reviews", icon: "calendar.badge.clock", color: Palette.tint)
                Divider().frame(height: 31).padding(.horizontal, 10)
                overviewCount(problems.count, title: "Payment notices", icon: "exclamationmark.shield", color: problems.isEmpty ? Palette.muted : warning)
            }.padding(.vertical, 10).padding(.horizontal, 12)
                .background(Palette.pale.opacity(0.7), in: RoundedRectangle(cornerRadius: 11))

            if !problems.isEmpty {
                ForEach(problems) { candidate in problemCard(candidate) }
            }
            if decisions.isEmpty {
                emptyState
            } else {
                ForEach(Array(decisions.prefix(4)), id: \.0.id) { item, plan in
                    decisionCard(item, plan: plan)
                }
                if decisions.count > 4 {
                    Text(L10n.format("%d more plans are available below.", decisions.count - 4))
                        .font(.caption).foregroundStyle(Palette.muted)
                }
            }
            if !model.permissionText.hasPrefix(L10n.text("Allowed")), model.items.contains(where: { $0.reminderDays != nil }) {
                Label("Check notification permission in Settings. Your decisions stay here if a banner is suppressed.", systemImage: "bell")
                    .font(.caption).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .sheet(item: $planning) { item in ProjectPlanEditor(model: model, item: item) }
        .alert("Have you checked this payment issue?", isPresented: Binding(get: { confirmingProblem != nil }, set: { if !$0 { confirmingProblem = nil } }), presenting: confirmingProblem) { candidate in
            Button("Keep open", role: .cancel) { confirmingProblem = nil }
            Button("I checked this issue") {
                do { try scan.dismissMatch(candidate) } catch { issue = error.localizedDescription }
                confirmingProblem = nil
            }
        } message: { candidate in
            Text(L10n.format("Confirm that you checked the affected account for %@. This closes only this notice. Check the provider for successful payment and continued access.", candidate.name))
        }
        .alert("Couldn’t save this decision", isPresented: Binding(get: { issue != nil }, set: { if !$0 { issue = nil } })) {
            Button("OK") { issue = nil }
        } message: { Text(L10n.text(issue ?? "")) }
    }

    private func overviewCount(_ count: Int, title: String, icon: String, color: Color) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon).font(.system(size: 17)).foregroundStyle(color).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(count, format: .number).font(.system(size: 20, weight: .semibold, design: .rounded)).monospacedDigit()
                Text(L10n.text(title)).font(.caption).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }.frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
    }

    private var emptyState: some View {
        let matches = scan.pending(for: model.items).filter { $0.kind != .paymentProblem }
        return VStack(alignment: .leading, spacing: 11) {
            HStack(alignment: .top, spacing: 13) {
                Image(systemName: model.items.isEmpty ? "plus.viewfinder" : "checkmark.seal.fill")
                    .font(.system(size: 28, weight: .light)).foregroundStyle(Palette.tint).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(L10n.text(model.items.isEmpty ? (matches.isEmpty ? "Start with one subscription" : "Confirm your first subscription") : (problems.isEmpty ? "No open decisions" : "No other plan reviews")))
                        .font(.headline)
                    Text(model.items.isEmpty ? (matches.isEmpty ? L10n.text("Add a service and when you expect to need it. You can connect Gmail whenever you are ready.") : L10n.format("Gmail found %d possible subscriptions. Confirm a match to add its project and renewal review.", matches.count)) : L10n.text("Your saved choices are up to date. Open a plan below when your needs change."))
                        .font(.callout).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            if model.items.isEmpty {
                if let first = matches.first {
                    Button("Review a Gmail match") { reviewEmail(first) }.buttonStyle(.borderedProminent)
                } else { Button("Add without Gmail", action: add).buttonStyle(.borderedProminent) }
            }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
    }

    private func problemCard(_ candidate: MailCandidate) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.shield.fill").font(.system(size: 25)).foregroundStyle(warning)
                .frame(width: 35).padding(.top, 2).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 9) {
                HStack(alignment: .firstTextBaseline) {
                    Text(candidate.name).font(.headline).lineLimit(2)
                    Spacer(minLength: 4)
                    Text("Check payment").font(.caption.weight(.medium)).foregroundStyle(Palette.ink)
                        .padding(.horizontal, 7).padding(.vertical, 3).background(warning.opacity(0.15), in: Capsule())
                }
                Text("Check the affected account before access is interrupted.")
                    .font(.callout).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button("Review evidence") { reviewEmail(candidate) }.buttonStyle(.borderedProminent)
                    Spacer(minLength: 4)
                    Button("I checked this issue…") { confirmingProblem = candidate }.font(.callout)
                }
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(L10n.format("Payment notice received %@", L10n.date(candidate.receivedAt)))
                        Text("A different receipt may belong to another plan. This notice stays open until you check it.")
                    }.font(.caption).foregroundStyle(Palette.muted).padding(.top, 5)
                } label: { Text("Why this needs a check").font(.caption).foregroundStyle(Palette.muted) }
            }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
            .overlay(alignment: .leading) { RoundedRectangle(cornerRadius: 2).fill(warning).frame(width: 3).padding(.vertical, 14).accessibilityHidden(true) }
    }

    private func decisionCard(_ item: Subscription, plan: DecisionPlan) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(alignment: .top, spacing: 10) {
                ServiceMark(name: item.name)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(item.name).font(.system(size: 17, weight: .semibold)).lineLimit(2)
                        if item.isEssential == true {
                            Image(systemName: "shield.fill").font(.caption).foregroundStyle(Palette.tint).accessibilityLabel("Essential")
                        }
                    }
                    if let purpose = item.purpose, !purpose.isEmpty {
                        Text(purpose).font(.caption).foregroundStyle(Palette.muted).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(Ledger.displayMoney(item.amount, item.currency)).font(.callout.weight(.semibold)).monospacedDigit()
                    Text(L10n.text(item.cadence == .annual ? "per year" : item.cadence == .monthly ? "per month" : "cycle unknown"))
                        .font(.caption).foregroundStyle(Palette.muted)
                }
            }
            HStack(spacing: 11) {
                reviewDateTile(plan)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 5) {
                        Text(L10n.text(plan.isOverdue ? "Review overdue" : plan.dueOn == nil ? "Choose a date" : "Review by"))
                            .font(.caption.weight(.medium)).foregroundStyle(plan.isOverdue ? urgent : Palette.muted)
                        if plan.isOverdue { Image(systemName: "exclamationmark.circle.fill").font(.caption).foregroundStyle(urgent).accessibilityHidden(true) }
                    }
                    Text(plan.dueOn.map { L10n.date(Day.toLocal($0)) } ?? L10n.text("Date not set"))
                        .font(.callout.weight(.semibold)).monospacedDigit()
                }
                Image(systemName: "arrow.right").font(.caption).foregroundStyle(Palette.muted.opacity(0.6)).padding(.horizontal, 2).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n.text(item.renewing ? "Expected next bill" : "Paid access ends"))
                        .font(.caption).foregroundStyle(Palette.muted)
                    Text((item.renewing ? item.nextBilling : item.accessEnds).map { L10n.date(Day.toLocal($0)) } ?? L10n.text("Unknown"))
                        .font(.callout.weight(.medium)).monospacedDigit()
                }
                Spacer(minLength: 0)
            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.pale.opacity(0.55), in: RoundedRectangle(cornerRadius: 9))
                .accessibilityElement(children: .combine)

            HStack(spacing: 8) {
                Button("Review plan") { planning = item }.buttonStyle(.borderedProminent)
                if let destination = renewalDestination(item) {
                    Link("Manage renewal", destination: destination)
                        .accessibilityHint("Opens the provider or store. Return to Billing details to confirm the outcome.")
                } else { Button("Billing details") { edit(item) } }
                Spacer(minLength: 0)
                if item.renewing && plan.kind != .verify {
                    Button("Keep this period") {
                        do { try model.acknowledgeDecision(item, key: plan.key) }
                        catch { issue = error.localizedDescription }
                    }.font(.callout)
                }
            }
            if item.renewing && item.cancelBy == nil {
                Label("Cancel-by date unverified", systemImage: "questionmark.circle")
                    .font(.caption).foregroundStyle(Palette.muted)
            }
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 7) {
                    Text(localizedDecisionReason(item, plan: plan)).font(.callout)
                    if item.renewing && item.cancelBy == nil {
                        Text("Check the provider before relying on this review date.").font(.caption)
                    }
                    Text(L10n.format("Billing verified by you %@", L10n.date(item.verifiedAt))).font(.caption)
                    if renewalDestination(item) != nil {
                        Button("Update billing or cancellation status") { edit(item) }.buttonStyle(.link).font(.caption)
                    }
                }.foregroundStyle(Palette.muted).padding(.top, 5)
            } label: { Text("Billing evidence & review reason").font(.caption).foregroundStyle(Palette.muted) }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.line.opacity(0.65)).allowsHitTesting(false) }
    }

    private func reviewDateTile(_ plan: DecisionPlan) -> some View {
        VStack(spacing: 1) {
            if let day = plan.dueOn {
                Image(systemName: "calendar").font(.system(size: 10)).accessibilityHidden(true)
                Text(String(Day.label(day).suffix(2))).font(.system(size: 22, weight: .semibold, design: .rounded)).monospacedDigit()
            } else { Image(systemName: "questionmark.square.dashed").font(.title3) }
        }.foregroundStyle(plan.isOverdue ? urgent : Palette.tint).frame(width: 40, height: 43)
            .background((plan.isOverdue ? urgent : Palette.tint).opacity(0.10), in: RoundedRectangle(cornerRadius: 7))
            .accessibilityHidden(true)
    }

    private func renewalDestination(_ item: Subscription) -> URL? {
        switch item.billingChannel {
        case "apple": return URL(string: "https://apps.apple.com/account/subscriptions")
        case "googlePlay": return URL(string: "https://play.google.com/store/account/subscriptions")
        case "website":
            let name = item.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return ["suno", "suno pro", "suno premier"].contains(name) ? URL(string: "https://suno.com/account") : nil
        default: return nil
        }
    }
}

private func localizedDecisionReason(_ item: Subscription, plan: DecisionPlan) -> String {
    if plan.kind == .project, let purpose = item.purpose, !purpose.isEmpty {
        return L10n.format("Review whether you still need this for %@.", purpose)
    }
    return L10n.text(plan.reason)
}

struct OptionalDecisionDate: View {
    let title: String
    @Binding var value: Date?
    private var enabled: Binding<Bool> {
        Binding(get: { value != nil }, set: { value = $0 ? (value ?? Day.fromLocal(Date())) : nil })
    }
    private var localDate: Binding<Date> {
        Binding(get: { value.map(Day.toLocal) ?? Date() }, set: { value = Day.fromLocal($0) })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(L10n.text(title), isOn: enabled).font(.callout)
            if value != nil {
                DatePicker(L10n.text(title), selection: localDate, displayedComponents: .date)
                    .labelsHidden().datePickerStyle(.field).accessibilityLabel(L10n.text(title))
            } else { Text("Not set").font(.caption).foregroundStyle(Palette.muted) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ProjectPlanEditor: View {
    @ObservedObject var model: AppModel
    let item: Subscription
    @Environment(\.dismiss) private var dismiss
    @State private var purpose: String
    @State private var needsUntil: Date?
    @State private var reviewOn: Date?
    @State private var essential: Bool
    @State private var reminderOn: Bool
    @State private var lead: Int
    @State private var issue: String?

    init(model: AppModel, item: Subscription) {
        self.model = model
        self.item = item
        _purpose = State(initialValue: item.purpose ?? "")
        _needsUntil = State(initialValue: item.needsUntil)
        _reviewOn = State(initialValue: item.reviewOn)
        _essential = State(initialValue: item.isEssential == true)
        _reminderOn = State(initialValue: item.reminderDays != nil)
        _lead = State(initialValue: item.reminderDays ?? 3)
    }

    private var revised: Subscription {
        var result = item
        result.purpose = purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        result.needsUntil = needsUntil
        result.reviewOn = reviewOn
        result.isEssential = essential
        result.reminderDays = reminderOn ? lead : nil
        return result
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Eyebrow("Your plans can change")
                Text(L10n.format("Review %@", item.name)).font(.title2.weight(.semibold))
                Text("Choose when to decide whether you still need this service.")
                    .font(.callout).foregroundStyle(Palette.muted)
            }.padding(20)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 17) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("What are you using it for?").font(.callout.weight(.medium))
                        TextField("e.g. Music for the launch video", text: $purpose).textFieldStyle(.roundedBorder)
                            .accessibilityLabel("Subscription purpose")
                    }
                    Toggle("Essential to my work or daily life", isOn: $essential)
                    HStack(alignment: .top, spacing: 18) {
                        OptionalDecisionDate(title: "Need it until", value: $needsUntil)
                        OptionalDecisionDate(title: "Review on", value: $reviewOn)
                    }
                    Divider()
                    Toggle("Send a local reminder", isOn: $reminderOn)
                    if reminderOn {
                        Stepper(value: $lead, in: 0...365) { Text(L10n.format(lead == 1 ? "Billing lead · %d day" : "Billing lead · %d days", lead)) }
                        Text("Project and review dates can bring the reminder forward. Check macOS notification permission in Settings.")
                            .font(.caption).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    let plan = DecisionPlan.make(revised)
                    VStack(alignment: .leading, spacing: 6) {
                        Label(plan.dueOn.map { L10n.format("Review %@", L10n.date(Day.toLocal($0))) } ?? L10n.text("Choose a review date"), systemImage: "calendar")
                            .font(.headline)
                        Text(localizedDecisionReason(revised, plan: plan)).font(.callout)
                        Text("An earlier bill or verified cancellation deadline still takes priority if your project moves.")
                            .font(.caption).foregroundStyle(Palette.muted)
                    }.padding(13).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Palette.pale, in: RoundedRectangle(cornerRadius: 10))
                    Text("To change renewal status, check the provider and update Billing details. Your purpose and dates do not change provider billing.")
                        .font(.caption).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    if let issue { Text(L10n.text(issue)).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
                }.padding(20)
            }
            Divider()
            HStack {
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Save plan") {
                    do { try model.updateIntent(revised); dismiss() }
                    catch { issue = error.localizedDescription }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }.padding(16)
        }.frame(width: 460, height: min(600, (NSScreen.main?.visibleFrame.height ?? 800) - 80))
            .foregroundStyle(Palette.ink).tint(Palette.tint).background(Palette.paper)
    }
}
