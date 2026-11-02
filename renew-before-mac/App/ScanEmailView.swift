import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct ScanEmailView: View {
    @ObservedObject var scan: EmailScanController
    @ObservedObject var model: AppModel
    var candidate: MailCandidate? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var review: CandidateReview?
    @State private var cacheProblem: String?

    var body: some View {
        if let review {
            if review.existing == nil && !review.alreadySaved && review.candidate.kind != .paymentProblem {
                ConfirmEmailSubscriptionView(model: model, scan: scan, candidate: review.candidate)
            } else {
            SubscriptionEditor(model: model, existing: review.existing,
                               scannedEmail: review.alreadySaved ? nil : review.candidate, sourceAddress: review.accountAddress) {
                if candidate != nil, model.items.contains(where: { $0.includesReceipt(review.candidate.draft.receiptID) }) {
                    dismiss()
                } else {
                    self.review = nil
                }
            }
            .id(review.id)
            }
        } else {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 9) {
                    Image(systemName: "envelope").foregroundStyle(Palette.tint)
                    Eyebrow("Gmail discovery")
                }
                .padding(.horizontal, 22).padding(.top, 20)
                if let candidate, let address = scan.connectedAddress {
                    focusedMatch(candidate, account: MailScanAccount(id: address, name: address, address: address))
                } else {
                    phaseContent
                }
            }
            .frame(width: min(495, (NSScreen.main?.visibleFrame.width ?? 900) - 45))
            .foregroundStyle(Palette.ink).tint(Palette.tint).background(Palette.paper)
            .alert("Couldn’t save this change", isPresented: Binding(get: { cacheProblem != nil }, set: { if !$0 { cacheProblem = nil } })) {
                Button("OK") { cacheProblem = nil }
            } message: { Text(cacheProblem ?? "") }
        }
    }

    @ViewBuilder private var phaseContent: some View {
        switch scan.phase {
        case .idle, .connecting:
            waiting(title: "Connect your Gmail account",
                    detail: "Choose an account in Google’s sign-in window and allow read-only Gmail access. Return here to see results.")
        case .scanning(let account):
            waiting(title: "Looking for subscriptions",
                    detail: L10n.format("Checking recent billing emails in %@. This can take a moment.", account.address))
        case .results(let account, let candidates, let summary):
            results(account: account, candidates: candidates.filter { !scan.isDismissed($0) }, summary: summary)
        case .setupRequired:
            clientSetup
        case .failed(let message):
            VStack(alignment: .leading, spacing: 10) {
                heading("Couldn’t finish the scan")
                Text(message).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }.padding(22)
            Divider()
            HStack {
                Button("Close", action: finish).keyboardShortcut(.cancelAction)
                Spacer()
                Button("Choose another account") { scan.changeAccount() }
                Button("Try again") { scan.start() }.buttonStyle(.borderedProminent)
            }.padding(16)
        }
    }

    private func waiting(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            heading(title)
            HStack(alignment: .top, spacing: 12) {
                ProgressView().controlSize(.small).padding(.top, 2)
                Text(L10n.text(detail)).font(.body).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            HStack { Spacer(); Button("Cancel") { scan.cancel(); finish() }.keyboardShortcut(.cancelAction) }
        }.padding(22)
    }

    private var clientSetup: some View {
        VStack(alignment: .leading, spacing: 13) {
            heading("Connect this build to Google")
            Text("This copy needs a Google OAuth desktop client before it can open Gmail sign-in. You only set this up once.")
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 9) {
                Label("Enable the Gmail API in your Google Cloud project.", systemImage: "1.circle")
                Label("Configure the OAuth consent screen, then create a Desktop app client and download its JSON file.", systemImage: "2.circle")
                Label("Choose that file below to continue to Google sign-in.", systemImage: "3.circle")
                Link("Open Google Cloud Clients", destination: URL(string: "https://console.cloud.google.com/auth/clients")!)
            }
            .font(.callout).foregroundStyle(Palette.muted)
            Text("Using someone else’s build? Ask its publisher for a copy with Google sign-in configured.")
                .font(.caption).foregroundStyle(Palette.muted)
            Divider()
            HStack {
                Button("Back", action: finish).keyboardShortcut(.cancelAction)
                Spacer()
                Button("Choose client JSON…", action: selectClient).buttonStyle(.borderedProminent)
            }
        }.padding(22)
    }

    private func selectClient() {
        let panel = NSOpenPanel()
        panel.title = L10n.text("Choose the Google OAuth desktop client")
        panel.prompt = L10n.text("Use client")
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            scan.useClientFile(url)
        }
    }

    private func focusedMatch(_ candidate: MailCandidate, account: MailScanAccount) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            heading("Review a match")
            Text("Choose a status after checking this service. You can dismiss a match that doesn’t belong in your subscriptions.")
                .font(.callout).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            resultRow(candidate, account: account)
            HStack { Spacer(); Button("Back to dashboard", action: finish).keyboardShortcut(.cancelAction) }
        }.padding(22)
    }

    private func results(account: MailScanAccount, candidates: [MailCandidate], summary: MailScanSummary) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 7) {
                heading(candidates.isEmpty ? L10n.text("Scan complete") : candidates.count == 1 ? L10n.text("1 possible subscription") : L10n.format("%d possible subscriptions", candidates.count))
                Text(account.address).font(.callout.weight(.semibold)).textSelection(.enabled)
                Text(coverage(summary)).font(.callout).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                if let total = paymentResult(summary) {
                    Label(total, systemImage: "creditcard").font(.callout.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true).accessibilityLabel(total)
                }
                if !scan.paymentReviews.isEmpty {
                    Text(L10n.format("%d receipt(s) need merchant or amount review. Open Check receipt evidence on the dashboard to include a verified payment.", scan.paymentReviews.count))
                        .font(.callout).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }
                if let count = summary.unresolvedCurrencyCount, count > 0 {
                    Text(count == 1 ? L10n.text("One receipt needs a currency. Confirm it on the dashboard to include it in spending.")
                         : L10n.format("%d receipts need a currency. Confirm them on the dashboard to include them in spending.", count))
                        .font(.callout).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }
            }.padding(.horizontal, 22).padding(.top, 12).padding(.bottom, 15)
            Divider()
            if candidates.isEmpty {
                VStack(alignment: .leading, spacing: 9) {
                    Label("No new subscription matches to review", systemImage: "envelope.open").font(.headline)
                    Text("Annual plans and services billed to another address may have no matching email in this period. Try another Gmail account or add a plan manually from the dashboard.")
                        .font(.callout).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }.padding(22)
            } else {
                Text("Matches are saved on this Mac. Choose a match to confirm its status, or open the dashboard to see your spending.")
                    .font(.callout).foregroundStyle(Palette.muted).padding(.horizontal, 22).padding(.top, 12)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(candidates, id: \.id) { candidate in
                            resultRow(candidate, account: account)
                        }
                    }.padding(.horizontal, 22).padding(.vertical, 12)
                }
                .frame(height: min(CGFloat(candidates.count) * 184, 350, max(125, (NSScreen.main?.visibleFrame.height ?? 800) - 350)))
            }
            Divider()
            HStack {
                Button("Switch account") { scan.changeAccount() }
                Spacer()
                Button("View dashboard", action: finish).buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }.padding(.horizontal, 22).padding(.vertical, 13)
        }
    }

    private func paymentResult(_ summary: MailScanSummary) -> String? {
        guard let count = summary.recordedCount, let totals = summary.recordedTotals else { return nil }
        guard count > 0 else { return L10n.text("No payments recorded from these emails.") }
        let amounts = totals.sorted { $0.key < $1.key }.map { Ledger.displayMoney($0.value, $0.key) }
        return L10n.format("%d recorded payments in this scan · %@", count, amounts.joined(separator: " · "))
    }

    private func coverage(_ summary: MailScanSummary) -> String {
        var detail = L10n.format("Checked %d matching emails from the last 90 days, including archived mail.", summary.inspected)
        if let count = summary.additionalReceiptEmails, count > 0 {
            detail += " " + L10n.format("The receipt search added %d to the billing search.", count)
        }
        if let count = summary.receiptPDFsUsed, count > 0 {
            detail += " " + (count == 1 ? L10n.text("Included text from one receipt PDF.") : L10n.format("Included text from %d receipt PDFs.", count))
        }
        if !summary.limitNote.isEmpty { detail += " " + L10n.text(summary.limitNote) }
        if summary.skipped > 0 { detail += " " + L10n.format("Couldn’t read %d of those messages.", summary.skipped) }
        return detail
    }

    private func resultRow(_ candidate: MailCandidate, account: MailScanAccount) -> some View {
        let saved = model.items.first { $0.includesReceipt(candidate.draft.receiptID) }
        let hasSimilarName = model.items.contains { $0.name.localizedCaseInsensitiveCompare(candidate.name) == .orderedSame }
        return VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .center, spacing: 9) {
                ServiceMark(name: candidate.name)
                Text(candidate.name).font(.headline).textSelection(.enabled)
                Spacer(minLength: 6)
                Text(saved == nil ? L10n.text(candidate.kind.label) : L10n.text("Already reviewed"))
                    .font(.caption.weight(.semibold)).foregroundStyle(Palette.tint)
            }
            if let amount = candidate.draft.amount, let currency = candidate.draft.currency {
                let cycle = candidate.draft.cadence.map { $0 == .monthly ? L10n.text(" / month") : L10n.text(" / year") } ?? ""
                Text(L10n.format("Email lists %@%@", Ledger.displayMoney(amount, currency), cycle))
                    .font(.callout.weight(.medium)).monospacedDigit()
            }
            if !candidate.subject.isEmpty {
                Text(candidate.subject).font(.callout).lineLimit(2).textSelection(.enabled)
            }
            let source = candidate.sender.isEmpty ? account.address : candidate.sender
            Text(source + " · " + L10n.date(candidate.receivedAt))
                .font(.caption).foregroundStyle(Palette.muted).lineLimit(2).textSelection(.enabled)
            if candidate.messageCount > 1 {
                Text(L10n.format("%d related emails · latest shown", candidate.messageCount)).font(.caption).foregroundStyle(Palette.muted)
            }
            if saved == nil && hasSimilarName {
                Text("There’s a saved plan with this name. Choose which record the email belongs to.")
                    .font(.caption).foregroundStyle(Palette.muted)
            }
            HStack {
                if let saved {
                    Button("View saved subscription") { review = CandidateReview(candidate, address: account.address, existing: saved, alreadySaved: true) }
                } else {
                    Button(model.items.isEmpty ? L10n.text("Review subscription") : L10n.text("Review as new")) { review = CandidateReview(candidate, address: account.address, existing: nil) }
                    if !model.items.isEmpty {
                        Menu {
                            ForEach(model.items.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }) { item in
                                Button(item.name + (item.evidence.isEmpty ? "" : " · " + String(item.evidence.prefix(65)))) {
                                    review = CandidateReview(candidate, address: account.address, existing: item)
                                }
                            }
                        } label: { Text("Update existing") }.menuStyle(.borderlessButton)
                        .fixedSize().accessibilityLabel("Update existing subscription")
                    }
                    Spacer(minLength: 2)
                    Button("Dismiss match") {
                        do {
                            try scan.dismissMatch(candidate)
                            if self.candidate != nil { finish() }
                        } catch { cacheProblem = error.localizedDescription }
                    }.buttonStyle(.link)
                }
            }.padding(.top, 3)
        }
        .padding(13).frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: 9))
        .overlay { RoundedRectangle(cornerRadius: 9).strokeBorder(Palette.line).allowsHitTesting(false) }
    }

    private func heading(_ text: String) -> some View {
        Text(L10n.text(text)).font(.system(size: 23, weight: .semibold, design: .rounded)).accessibilityAddTraits(.isHeader)
    }

    private func finish() { dismiss() }
}

private struct CandidateReview: Identifiable {
    let id = UUID()
    let candidate: MailCandidate
    let existing: Subscription?
    let accountAddress: String
    let alreadySaved: Bool

    init(_ candidate: MailCandidate, address: String, existing: Subscription?, alreadySaved: Bool = false) {
        self.accountAddress = address
        self.candidate = candidate
        self.existing = existing
        self.alreadySaved = alreadySaved
    }
}


private extension Subscription {
    func includesReceipt(_ id: String) -> Bool {
        receiptID == id || receiptHistory?.contains(id) == true
    }
}
