import XCTest
@testable import RenewCore

final class SenderAuthenticationTests: XCTestCase {
    func testOnlyReceivingGmailResultWithAlignedFromQualifies() {
        let pass = "mx.google.com; dkim=pass header.i=@anthropic.com; dmarc=pass (p=REJECT) header.from=anthropic.com"
        XCTAssertEqual(SenderAuthentication.gmailDomain(results: [pass], sender: "Anthropic <receipts@anthropic.com>"), "anthropic.com")
        XCTAssertNil(SenderAuthentication.gmailDomain(results: [], sender: "receipts@anthropic.com"))
        XCTAssertNil(SenderAuthentication.gmailDomain(results: [pass], sender: "receipts@unrelated.example"))
        XCTAssertNil(SenderAuthentication.gmailDomain(results: [pass.replacingOccurrences(of: "mx.google.com", with: "unrelated.example")], sender: "receipts@anthropic.com"))
        let fail = "mx.google.com; dmarc=fail header.from=anthropic.com"
        XCTAssertNil(SenderAuthentication.gmailDomain(results: [fail, pass], sender: "receipts@anthropic.com"))
        XCTAssertNil(SenderAuthentication.gmailDomain(results: [pass + "; dmarc=fail header.from=anthropic.com"], sender: "receipts@anthropic.com"))
        XCTAssertNil(SenderAuthentication.gmailDomain(results: ["mx.google.com; dmarc=pass header.from=anthropic.com.evil.example"], sender: "receipts@anthropic.com"))
    }
}
