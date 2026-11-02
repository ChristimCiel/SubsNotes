import SwiftUI

/// Relative bars compare recorded payments within one currency, without currency conversion.
struct SpendingChart: View {
    let summary: PaymentSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Where your money went", systemImage: "chart.bar.xaxis")
                .font(.headline).accessibilityAddTraits(.isHeader)
            ForEach(summary.totals.keys.sorted(), id: \.self) { currency in
                currencyChart(currency)
            }
        }.padding(16).background(Palette.card, in: RoundedRectangle(cornerRadius: 14))
    }

    private func currencyChart(_ currency: String) -> some View {
        let services = summary.byService.filter { ($0.totals[currency] ?? 0) > 0 }.sorted {
            ($0.totals[currency] ?? 0) > ($1.totals[currency] ?? 0)
        }
        let maximum = services.first?.totals[currency] ?? 1
        return VStack(alignment: .leading, spacing: 12) {
            Text(L10n.text("Spending by service") + " · " + currency)
                .font(.caption).foregroundStyle(Palette.muted)
            ForEach(Array(services.prefix(5))) { service in
                let amount = service.totals[currency] ?? 0
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        ServiceMark(name: service.service, size: 22)
                        Text(verbatim: service.service).lineLimit(1)
                        Spacer(minLength: 10)
                        Text(Ledger.displayMoney(amount, currency)).monospacedDigit()
                    }.font(.callout)
                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Palette.pale)
                            Capsule().fill(Palette.tint)
                                .frame(width: max(2, geometry.size.width * NSDecimalNumber(decimal: amount / maximum).doubleValue))
                        }
                    }.frame(height: 7).accessibilityHidden(true)
                }.accessibilityElement(children: .combine)
            }
        }
    }
}
