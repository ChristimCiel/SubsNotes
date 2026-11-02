import AppKit
import CoreText
import XCTest
@testable import RenewCore

final class ReceiptDocumentTests: XCTestCase {
    private func pdf(pages: [[String]], encrypted: Bool = false, rasterized: Bool = false, pageWidth: CGFloat = 400) throws -> Data {
        let bytes = NSMutableData()
        let consumer = try XCTUnwrap(CGDataConsumer(data: bytes as CFMutableData))
        var box = CGRect(x: 0, y: 0, width: pageWidth, height: 600)
        let passwords = [kCGPDFContextUserPassword as String: "test-fixture", kCGPDFContextOwnerPassword as String: "test-owner"]
        let context = try XCTUnwrap(CGContext(consumer: consumer, mediaBox: &box, encrypted ? passwords as CFDictionary : nil))
        for lines in pages {
            context.beginPDFPage(nil)
            let target: CGContext
            if rasterized {
                target = try XCTUnwrap(CGContext(data: nil, width: 400, height: 600,
                    bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceGray(),
                    bitmapInfo: CGImageAlphaInfo.none.rawValue))
                target.setFillColor(gray: 1, alpha: 1)
                target.fill(box)
            } else {
                target = context
            }
            for (index, line) in lines.enumerated() {
                let text = NSAttributedString(string: line, attributes: [.font: NSFont.systemFont(ofSize: 14)])
                target.textPosition = CGPoint(x: 20, y: 500 - 25 * index)
                CTLineDraw(CTLineCreateWithAttributedString(text as CFAttributedString), target)
            }
            if rasterized { context.draw(try XCTUnwrap(target.makeImage()), in: box) }
            context.endPDFPage()
        }
        context.closePDF()
        return bytes as Data
    }

    func testTextBasedPDFReadsMultiplePagesAndRecurringFieldsOnly() throws {
        let document = try pdf(pages: [
            ["Service: Paper Studio", "Amount paid: EUR 75.00", "Invoice date: 2030-04-02"],
            ["Renewal price: EUR 80.00", "Billed every year", "Next payment date: 2031-04-02"]
        ])
        let draft = try ReceiptParser.parse(document, filename: "invoice.PDF")
        XCTAssertEqual(draft.name, "Paper Studio")
        XCTAssertEqual(draft.amount, 80)
        XCTAssertEqual(draft.currency, "EUR")
        XCTAssertEqual(draft.cadence, .annual)
        XCTAssertEqual(draft.nextBilling, Day.parse("2031-04-02"))
    }

    func testPDFWithFlattenedRowsKeepsPaidAndRecurringFieldsSeparate() throws {
        let document = try pdf(pages: [[
            "Service: Paper Studio Amount paid: EUR 75.00 Invoice date: 2030-04-02"
        ], ["Renewal price: EUR 80.00 Billed every year Next payment date: 2031-04-02"]], pageWidth: 1200)
        let draft = try ReceiptParser.parse(document, filename: "flattened.pdf")
        XCTAssertEqual(draft.name, "Paper Studio")
        XCTAssertEqual(draft.amount, 80)
        XCTAssertEqual(draft.currency, "EUR")
        XCTAssertEqual(draft.cadence, .annual)
        XCTAssertEqual(draft.nextBilling, Day.parse("2031-04-02"))
    }

    func testLockedPDFAndGraphicsOnlyPDFAndExcessPagesDeclineImport() throws {
        let scanned = try pdf(pages: [["Service: In an image"]], rasterized: true)
        XCTAssertThrowsError(try ReceiptParser.parse(scanned, filename: "scan.pdf")) {
            XCTAssertEqual($0 as? ReceiptImportError, .imagePDF)
        }
        let long = try pdf(pages: Array(repeating: [], count: 21))
        XCTAssertThrowsError(try ReceiptParser.parse(long, filename: "long.pdf")) {
            XCTAssertEqual($0 as? ReceiptImportError, .tooManyPages)
        }
        let locked = try pdf(pages: [["Service: Protected"]], encrypted: true)
        XCTAssertThrowsError(try ReceiptParser.parse(locked, filename: "private.pdf")) {
            XCTAssertEqual($0 as? ReceiptImportError, .lockedPDF)
        }
    }

    private func container(_ parts: [String], type: String, boundary: String) -> String {
        let joined = parts.map { "--" + boundary + "\n" + $0 }.joined(separator: "\n")
        return "Content-Type: multipart/" + type + ";\n boundary=\"" + boundary + "\"\n\nPreamble\n"
            + joined + "\n--" + boundary + "--\nEpilogue"
    }

    func testMultipartNestedMailUsesSingleInlinePlainPartAndDiscardsAttachments() throws {
        let visible = "Service: Cloud Notes\nRecurring total: TWD 250\nBilled every month"
        let plain = "Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n" + Data(visible.utf8).base64EncodedString()
        let html = "Content-Type: text/html\n\nService: Bad HTML"
        let alternative = container([plain, html], type: "alternative", boundary: "CASE-Sensitive-A")
        let attachment = "Content-Disposition: attachment\nContent-Type: text/plain\n\nService: Wrong Attachment"
        let named = "Content-Type: text/plain; name*=UTF-8''invoice.txt\n\nService: Also Wrong"
        let forwarded = "Content-Type: message/rfc822\n\nContent-Type: text/plain\n\nService: Forwarded"
        let mail = container([attachment, named, forwarded, alternative], type: "mixed", boundary: "OUTER")
        let draft = try ReceiptParser.parse(Data(mail.utf8), filename: "billing.eml")
        XCTAssertEqual(draft.name, "Cloud Notes")
        XCTAssertEqual(draft.amount, 250)
        XCTAssertEqual(draft.cadence, .monthly)
        XCTAssertEqual(draft.receiptID, try ReceiptParser.parse(Data(visible.utf8), filename: "copy.txt").receiptID)
        XCTAssertFalse(draft.excerpt.contains("Wrong"))
    }

    func testAmbiguousAndMissingInlinePartsRequireManualReview() throws {
        let a = "Content-type: text/plain\n\nService: One"
        let b = "Content-type: text/plain\n\nService: Two"
        let attached = "Content-disposition: inline; filename=receipt.txt\nContent-type: text/plain\n\nService: Attached"
        let ambiguous = container([a, b], type: "mixed", boundary: "XYZ")
        let none = container([attached], type: "mixed", boundary: "ABC")
        XCTAssertThrowsError(try ReceiptParser.parse(Data(ambiguous.utf8), filename: "bill.eml")) {
            XCTAssertEqual($0 as? ReceiptImportError, .ambiguousMail)
        }
        XCTAssertThrowsError(try ReceiptParser.parse(Data(none.utf8), filename: "bill.eml")) {
            XCTAssertEqual($0 as? ReceiptImportError, .unsupportedMail)
        }
    }

    func testLimitsForExtractedTextAndMultipartComplexity() {
        XCTAssertThrowsError(try ReceiptParser.parse(Data(repeating: 65, count: 1_048_577), filename: "text.txt")) {
            XCTAssertEqual($0 as? ReceiptImportError, .tooMuchText)
        }
        var nested = "Content-type: text/plain\n\nService: Buried"
        for index in 0..<6 { nested = container([nested], type: "mixed", boundary: "level-\(index)") }
        XCTAssertThrowsError(try ReceiptParser.parse(Data(nested.utf8), filename: "nested.eml")) {
            XCTAssertEqual($0 as? ReceiptImportError, .unsupportedMail)
        }
        let many = container(Array(repeating: "Content-Type: text/html\n\n<p/>", count: 65), type: "mixed", boundary: "many")
        XCTAssertThrowsError(try ReceiptParser.parse(Data(many.utf8), filename: "many.eml")) {
            XCTAssertEqual($0 as? ReceiptImportError, .unsupportedMail)
        }
    }
}
