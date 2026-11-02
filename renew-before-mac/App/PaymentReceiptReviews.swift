import SwiftUI

struct PaymentReceiptReviews: View {
    @ObservedObject var scan: EmailScanController
    @State private var selected: PaymentReview?
    @State private var expanded = false

    var body: some View {
        if !scan.paymentReviews.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Label("Check receipt evidence", systemImage: "exclamationmark.shield")
                    .font(.headline).accessibilityAddTraits(.isHeader)
                Text("These payments are outside spending totals until you check the original receipt. A service name in an email does not verify its merchant.")
                    .font(.callout).foregroundStyle(Palette.muted)
                ForEach(expanded ? scan.paymentReviews : Array(scan.paymentReviews.prefix(3))) { review in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(review.options.first?.service ?? L10n.text("Receipt")).font(.callout.weight(.semibold))
                            Text(L10n.text(review.reason.label)).font(.caption).foregroundStyle(Palette.muted)
                            if let option = review.options.first {
                                Text(Day.label(option.day) + " · " + Ledger.displayMoney(option.amount, option.currency ?? ""))
                                    .font(.caption).foregroundStyle(Palette.muted)
                            }
                        }
                        Spacer(minLength: 10)
                        Button("Check receipt") { selected = review }
                            .accessibilityLabel(L10n.format("Check receipt for %@", review.options.first?.service ?? L10n.text("unknown merchant")))
                    }
                }
                if scan.paymentReviews.count > 3 {
                    Button(expanded ? L10n.text("Show fewer") : L10n.format("Show all %d receipts", scan.paymentReviews.count)) { expanded.toggle() }
                }
            }.padding(14).background(Palette.pale, in: RoundedRectangle(cornerRadius: 12))
                .sheet(item: $selected) { review in ReceiptEvidenceView(scan: scan, review: review) }
        }
    }
}

private struct ReceiptEvidenceView: View {
    @ObservedObject var scan: EmailScanController
    let review: PaymentReview
    @Environment(\.dismiss) private var dismiss
    @State private var optionID = ""
    @State private var currency = ""
    @State private var checked = false
    @State private var error: String?
    @State private var excluding = false

    private var option: PaymentReviewOption? { review.options.first { $0.id == optionID } }

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            Text(L10n.text(review.reason.label)).font(.title2.weight(.semibold))
            Text(L10n.text(review.reason == .conflictingReceipt
                 ? "Different values share the same receipt identity. Check the original receipt in your mailbox, then choose the correct payment."
                 : "Check the merchant, paid amount and date against the original receipt in your mailbox. Forwarded or unauthenticated mail needs your review."))
                .font(.callout).foregroundStyle(Palette.muted)
            Picker("Payment on the original receipt", selection: $optionID) {
                Text("Choose a payment").tag("")
                ForEach(review.options) { value in
                    Text(value.service + " · " + Ledger.displayMoney(value.amount, value.currency ?? "") + " · " + Day.label(value.day))
                        .tag(value.id)
                }
            }
            if let option {
                Text(L10n.text(option.dateSource.label)).font(.caption).foregroundStyle(Palette.muted)
                if option.currency == nil {
                    TextField("ISO currency, e.g. USD or CAD", text: $currency)
                        .textFieldStyle(.roundedBorder)
                }
            }
            Toggle("I checked the original receipt and merchant", isOn: $checked)
            if let error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Exclude receipt", role: .destructive) { excluding = true }
                Spacer()
                Button("Back") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Confirm payment") {
                    do {
                        try scan.confirmPaymentReview(review, optionID: optionID,
                            currency: option?.currency ?? currency.trimmingCharacters(in: .whitespacesAndNewlines).uppercased())
                        dismiss()
                    } catch { self.error = error.localizedDescription }
                }.buttonStyle(.borderedProminent).disabled(!checked || option == nil)
            }
        }.padding(24).frame(width: 490)
            .onChange(of: optionID) { _, _ in checked = false; error = nil }
            .confirmationDialog("Exclude this receipt from spending?", isPresented: $excluding, titleVisibility: .visible) {
                Button("Exclude receipt", role: .destructive) {
                    do { try scan.dismissPaymentReview(review); dismiss() }
                    catch { self.error = error.localizedDescription }
                }
            } message: { Text("All versions of this receipt will stay excluded on future scans. Other payments are kept.") }
    }
}
