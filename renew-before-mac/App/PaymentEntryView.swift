import SwiftUI

struct PaymentEntryView: View {
    @ObservedObject var scan: EmailScanController
    @Environment(\.dismiss) private var dismiss
    @State private var service = ""
    @State private var amount = ""
    @State private var currency = ""
    @State private var date = Date()
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Eyebrow("Spending history")
            Text("Record a payment").font(.title2.bold())
            Text("Enter the amount you actually paid, including any tax. Check the recorded payments first to avoid counting a receipt twice.")
                .font(.callout).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
                GridRow { Text("Service"); TextField("Service name", text: $service) }
                GridRow { Text("Amount paid"); TextField("e.g. 19.99", text: $amount).accessibilityLabel("Amount paid") }
                GridRow { Text("Currency"); TextField("e.g. USD or TWD", text: $currency).accessibilityLabel("Currency") }
                GridRow { Text("Payment date"); DatePicker("Payment date", selection: $date, in: ...Date(), displayedComponents: .date).labelsHidden() }
            }
            Text(L10n.format("Saved locally · %@", scan.connectedAddress ?? L10n.text("On this Mac"))).font(.caption).foregroundStyle(Palette.muted)
            if let error { Text(error).font(.callout).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save payment", action: save).buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }
        }.padding(22).frame(width: 405).foregroundStyle(Palette.ink).tint(Palette.tint).background(Palette.paper)
    }

    private func save() {
        let amountText = amount.trimmingCharacters(in: .whitespacesAndNewlines)
        guard amountText.range(of: #"^\d{1,12}(?:\.\d{1,6})?$"#, options: .regularExpression) != nil,
              let value = Decimal(string: amountText, locale: Locale(identifier: "en_US_POSIX")), value > 0 else {
            error = L10n.text("Enter a positive amount, such as 19.99."); return
        }
        let payment = RecordedPayment(id: UUID().uuidString, service: service.trimmingCharacters(in: .whitespacesAndNewlines),
                                      amount: value, currency: currency.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
                                      day: Day.fromLocal(date), dateSource: .manual)
        do { try scan.recordPayment(payment); dismiss() }
        catch { self.error = error.localizedDescription }
    }
}
