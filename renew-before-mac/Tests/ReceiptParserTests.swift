import Foundation
import XCTest
@testable import RenewCore

final class ReceiptParserTests: XCTestCase {
    private func parse(_ body: String, ext: String = "txt") throws -> ReceiptDraft {
        try ReceiptParser.parse(Data(body.utf8), filename: "billing.\(ext)")
    }

    func testIncludedFictionalEMLImportsWithoutSavingMailHeaders() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Examples/sample-receipt.eml")
        let draft = try ReceiptParser.parse(Data(contentsOf: fixture), filename: fixture.lastPathComponent)
        XCTAssertEqual(draft.name, "Example Studio")
        XCTAssertEqual(draft.amount, Decimal(string: "12.50"))
        XCTAssertEqual(draft.currency, "USD")
        XCTAssertEqual(draft.cadence, .monthly)
        XCTAssertEqual(draft.nextBilling, Day.parse("2030-05-12"))
        XCTAssertTrue(draft.excerpt.contains("Recurring amount: USD 12.50"))
        XCTAssertFalse(draft.excerpt.contains("example.invalid"))
        XCTAssertEqual(draft.receiptID.count, 64)
    }

    func testOnlyExplicitRenewalDateAndPriceBecomeDraftCandidates() throws {
        let draft = try parse("""
        Invoice date: 2030-02-01
        Cancel by: 2030-01-30
        Access ends: 2030-03-05
        Trial ends: 2030-03-10
        Amount paid: USD 180.00
        Order number: 304000
        Total: USD 190.00
        """)
        XCTAssertNil(draft.nextBilling)
        XCTAssertNil(draft.amount)
        XCTAssertNil(draft.currency)
        XCTAssertNil(draft.name)
        XCTAssertNil(draft.cadence)
        XCTAssertTrue(draft.excerpt.contains("Access ends: 2030-03-05"))
    }

    func testConflictingFieldsRemainUnknown() throws {
        let draft = try parse("""
        Service: One
        Service: Two
        Recurring amount: USD 3.00
        Recurring amount: EUR 3.00
        Billing cycle: monthly
        Billing cycle: annual
        Renewal date: 2030-02-01
        Renewal date: 2030-03-01
        """)
        XCTAssertNil(draft.name)
        XCTAssertNil(draft.amount)
        XCTAssertNil(draft.currency)
        XCTAssertNil(draft.cadence)
        XCTAssertNil(draft.nextBilling)
    }

    func testInvalidAndAmbiguousValuesAreNotCoerced() throws {
        for value in ["$25", "12,34", "10.00 + tax", "1 or 2", "9.999999999", "-2.00", "12.00 QQQ"] {
            let draft = try parse("Amount: \(value)\nNext billing date: 06/11/2027\nCadence: 3 months")
            XCTAssertNil(draft.amount)
            XCTAssertNil(draft.currency)
            XCTAssertNil(draft.nextBilling)
            XCTAssertNil(draft.cadence)
        }
        let mixed = try parse("Next billing: 2030-01-01\nNext charge date: To be determined")
        XCTAssertNil(mixed.nextBilling)
        let mixedPrices = try parse("Amount: USD 10.00\nAmount: EUR 4.00 plus tax")
        XCTAssertNil(mixedPrices.amount)
        XCTAssertNil(mixedPrices.currency)
    }

    func testIndependentFieldsAndConsistentRepeatsCanBeAccepted() throws {
        let draft = try parse("""
        AMOUNT: 2.75
        Currency: EUR
        Currency: eur
        Billing frequency: yearly
        Service: Music
        Next billing date: 2032-02-29
        """)
        XCTAssertEqual(draft.amount, Decimal(string: "2.75"))
        XCTAssertEqual(draft.currency, "EUR")
        XCTAssertEqual(draft.cadence, .annual)
        XCTAssertEqual(draft.nextBilling, Day.parse("2032-02-29"))
        let noCurrency = try parse("Amount: 2.75")
        XCTAssertEqual(noCurrency.amount, Decimal(string: "2.75"))
        XCTAssertNil(noCurrency.currency)
    }

    func testDigestIgnoresFilenameHeadersTransferEncodingAndLineEndings() throws {
        let body = "Service: 音樂\nAmount: TWD 120"
        let plain = try parse(body)
        let b64 = Data(body.replacingOccurrences(of: "\n", with: "\r\n").utf8).base64EncodedString()
        let mail = "Subject: Example\r\nContent-Type: text/plain;\r\n charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + b64
        let encoded = try ReceiptParser.parse(Data(mail.utf8), filename: "copy.EML")
        XCTAssertEqual(plain.receiptID, encoded.receiptID)
        XCTAssertEqual(plain.name, encoded.name)
        let quoted = "Content-Transfer-Encoding: quoted-printable\n\nService: =E9=9F=B3=\n=E6=A8=82\nAmount: TWD 120\n"
        XCTAssertEqual(try parse(quoted, ext: "eml").receiptID, plain.receiptID)
        XCTAssertNotEqual(try parse(body + "0").receiptID, plain.receiptID)
    }

    func testExplicitRateAndSpelledOutBillingDate() throws {
        for value in ["November 4, 2030", "Nov 4, 2030", "4 Nov 2030", "4 November 2030"] {
            let draft = try parse("Renewal price: USD 12.50/month\nNext billing date: \(value)")
            XCTAssertEqual(draft.amount, Decimal(string: "12.50"))
            XCTAssertEqual(draft.currency, "USD")
            XCTAssertEqual(draft.cadence, .monthly)
            XCTAssertEqual(draft.nextBilling, Day.parse("2030-11-04"))
        }
        let mismatch = try parse("Renewal price: 12.50 USD per month\nBilled annually")
        XCTAssertNil(mismatch.cadence)
        XCTAssertNil(mismatch.amount)
        XCTAssertNil(try parse("Next billing date: February 29, 2030").nextBilling)
        XCTAssertNil(try parse("Total: 12.50 USD/month").amount)
    }

    func testUnsupportedMIMEAttachmentsAndBadEncodingReportActionableErrors() {
        let cases = [
            "Content-Type: multipart/alternative; boundary=x\n\n--x\nService: Wrong",
            "Content-Type: text/html\n\n<b>Service: Wrong</b>",
            "Content-Type: text/plain; charset=iso-8859-1\n\nService: Wrong",
            "Content-Disposition: attachment\n\nService: Wrong",
            "Content-Type: text/html\nContent-Type: text/plain\n\nService: Wrong",
            "Content-Transfer-Encoding: base64\n\n!!!",
            "Content-Transfer-Encoding: quoted-printable\n\nService: Bad=ZZ",
            "Service: This is not a mail header and body"
        ]
        for mail in cases {
            XCTAssertThrowsError(try parse(mail, ext: "eml")) { error in
                XCTAssertFalse(error.localizedDescription.isEmpty)
            }
        }
    }

    func testFileTypeSizeEmptyAndBinaryGuards() {
        XCTAssertThrowsError(try parse("Amount: 10", ext: "pdf"))
        XCTAssertThrowsError(try parse("   \n\t"))
        XCTAssertThrowsError(try parse("Service: \u{0000}42"))
        XCTAssertThrowsError(try ReceiptParser.parse(Data([0xff]), filename: "bill.txt"))
        XCTAssertThrowsError(try ReceiptParser.parse(Data(repeating: 65, count: ReceiptParser.maxBytes + 1), filename: "bill.txt"))
    }
}
