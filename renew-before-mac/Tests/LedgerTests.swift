import Foundation
import XCTest
@testable import RenewCore

final class LedgerTests: XCTestCase {
    func testMonthlyCostsByCurrencyAndRenewalStatus() {
        let items = [
            Subscription(name: "Monthly", amount: Decimal(string: "3.25")!, currency: "USD", cadence: .monthly),
            Subscription(name: "Annual", amount: 90, currency: "USD", cadence: .annual),
            Subscription(name: "Another currency", amount: 150, currency: "TWD", cadence: .monthly),
            Subscription(name: "Stopped", amount: 100, currency: "USD", renewing: false)
        ]
        XCTAssertEqual(Ledger.monthlyTotals(items), ["USD": Decimal(string: "10.75")!, "TWD": 150])
        XCTAssertEqual(Ledger.monthlyTotals([]), [:])
    }

    func testDashboardKeepsIncompletePricesOutOfBothEstimates() {
        var canceled = Subscription(name: "Former plan", amount: 800, currency: "USD", cadence: .monthly)
        canceled.status = .canceled
        let summary = Ledger.spendingSummary([
            Subscription(name: "Monthly", amount: 5, currency: "USD", cadence: .monthly),
            Subscription(name: "Annual", amount: 13, currency: "USD", cadence: .annual),
            Subscription(name: "Free plan", amount: 0, currency: "EUR", cadence: .annual),
            Subscription(name: "Unknown price", currency: "EUR", cadence: .annual),
            Subscription(name: "Missing currency", amount: 60, cadence: .monthly),
            Subscription(name: "Unknown cycle", amount: 29, currency: "TWD"),
            canceled
        ])
        XCTAssertEqual(summary.annualByCurrency, ["USD": 73, "EUR": 0])
        XCTAssertEqual(summary.monthlyByCurrency, ["USD": 5 + Decimal(13) / 12, "EUR": 0])
        XCTAssertEqual(summary.excludedActiveCount, 3)
    }

    func testAnnualAmountsAreAggregatedBeforeDivision() {
        let items = (1...12).map { Subscription(name: "Service \($0)", amount: 1, currency: "EUR", cadence: .annual) }
        XCTAssertEqual(Ledger.monthlyTotals(items)["EUR"], 1)
    }

    func testValidationIdentifiesOnlyInvalidInputs() {
        var item = Subscription(name: "  ", amount: 0, currency: "USD")
        XCTAssertNotNil(Ledger.validate(item))
        item.name = "Calendar"
        XCTAssertNil(Ledger.validate(item))
        item.amount = -1
        XCTAssertNotNil(Ledger.validate(item))
        item.amount = .nan
        XCTAssertNotNil(Ledger.validate(item))
        item.amount = 1
        item.currency = "QQQ"
        XCTAssertNotNil(Ledger.validate(item))
        item.currency = "TWD"
        for days in [0, 365] {
            item.reminderDays = days
            XCTAssertNil(Ledger.validate(item))
        }
        for days in [-1, 366] {
            item.reminderDays = days
            XCTAssertNotNil(Ledger.validate(item))
        }
    }

    func testUnknownDatesStayUnknownAndVerifiedAtRemainsAnInstant() throws {
        var item = Subscription(name: "Calendar", amount: 1, currency: "USD")
        item.verifiedAt = Date(timeIntervalSince1970: 1_860_000_123)
        let copy = try JSONDecoder().decode(Subscription.self, from: JSONEncoder().encode(item))
        XCTAssertEqual(copy, item)
        XCTAssertNil(copy.nextBilling)
        XCTAssertNil(copy.accessEnds)
        XCTAssertNil(copy.started)
        XCTAssertNil(copy.reminderDays)
        XCTAssertNotEqual(item.id, Subscription().id)
    }

    func testDateOnlyRoundTripAcrossDSTBoundaries() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .autoupdatingCurrent
        for text in ["2028-02-29", "2027-03-14", "2027-11-07"] {
            let day = try XCTUnwrap(Day.parse(text))
            XCTAssertEqual(Day.label(day), text)
            let local = Day.toLocal(day)
            let localEvening = try XCTUnwrap(calendar.date(bySettingHour: 23, minute: 25, second: 0, of: local))
            XCTAssertEqual(Day.fromLocal(localEvening), day)
        }
    }

    func testCivilDateValidationRejectsAmbiguityAndNormalization() {
        for invalid in ["2027-02-29", "2027-04-31", "2027-00-01", "11/01/2027", "2027-1-01", "0000-00-00"] {
            XCTAssertNil(Day.parse(invalid))
        }
    }

    func testMoneyLabelsUseAnExplicitCurrencyCode() {
        XCTAssertTrue(Ledger.displayMoney(12, "USD").contains("USD"))
        XCTAssertTrue(Ledger.displayMoney(12, "TWD").contains("TWD"))
    }
}
