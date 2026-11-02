import SwiftUI

/// A bare dollar symbol needs a human choice before its payment can enter a currency total.
struct PaymentCurrencyReviews: View {
    @ObservedObject var scan: EmailScanController
    @State private var selected: PaymentCurrencyReview?
    @State private var showAll = false

    var body: some View {
        if !scan.currencyReviews.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Receipts missing a currency").font(.headline).accessibilityAddTraits(.isHeader)
                Text("These receipts show a paid amount with a $ symbol. Confirm the currency to include a payment in your spending.")
                    .font(.callout).foregroundStyle(Palette.muted)
                ForEach(showAll ? scan.currencyReviews : Array(scan.currencyReviews.prefix(3)), id: \.id) { receipt in
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(receipt.service).font(.callout.weight(.semibold))
                            Text(Day.label(receipt.day) + " · " + L10n.text(receipt.dateSource.label))
                                .font(.caption).foregroundStyle(Palette.muted)
                        }
                        Spacer()
                        Text("$" + NSDecimalNumber(decimal: receipt.amount).stringValue).monospacedDigit()
                        Button("Review") { selected = receipt }
                            .accessibilityLabel(L10n.format("Review payment currency for %@", receipt.service))
                    }.padding(.vertical, 4)
                }
                if scan.currencyReviews.count > 3 {
                    Button(showAll ? L10n.text("Show fewer receipts") : L10n.format("Show all %d receipts", scan.currencyReviews.count)) { showAll.toggle() }
                        .buttonStyle(.link)
                }
            }.padding(14).background(Palette.pale, in: RoundedRectangle(cornerRadius: 10))
                .sheet(item: $selected) { receipt in PaymentCurrencyView(scan: scan, receipt: receipt) }
        }
    }
}

private struct PaymentCurrencyView: View {
    @ObservedObject var scan: EmailScanController
    let receipt: PaymentCurrencyReview
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var custom = ""
    @State private var error: String?
    @State private var confirmSkip = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Eyebrow("Receipt review")
            Text("Confirm payment currency").font(.title2.bold())
            Text(receipt.service + " · $" + NSDecimalNumber(decimal: receipt.amount).stringValue).font(.headline)
            Text(Day.label(receipt.day) + " · " + L10n.text(receipt.dateSource.label)).font(.caption).foregroundStyle(Palette.muted)
            Text("Check the currency on the original receipt or in the service’s billing settings.").font(.callout)
            Picker("Payment currency", selection: $code) {
                Text("Choose currency…").tag("")
                ForEach(["USD", "TWD", "CAD", "AUD", "HKD", "SGD", "NZD"], id: \.self) { Text($0).tag($0) }
                Text("Other currency…").tag("other")
            }
            if code == "other" { TextField("3-letter currency code", text: $custom) }
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
            HStack {
                Button("Exclude…") { confirmSkip = true }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Record payment") {
                    do {
                        let selected = code == "other" ? custom.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() : code
                        try scan.confirmCurrency(for: receipt, currency: selected)
                        dismiss()
                    } catch { self.error = error.localizedDescription }
                }.disabled(code.isEmpty).buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }
        }.padding(22).frame(width: 405).foregroundStyle(Palette.ink).tint(Palette.tint).background(Palette.paper)
        .alert("Exclude this receipt?", isPresented: $confirmSkip) {
            Button("Keep receipt", role: .cancel) {}
            Button("Exclude", role: .destructive) {
                do { try scan.dismissCurrencyReview(receipt); dismiss() }
                catch { self.error = error.localizedDescription }
            }
        } message: { Text("Future scans will skip this payment.") }
    }
}
