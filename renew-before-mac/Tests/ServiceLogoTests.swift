import AppKit
import Foundation
import XCTest
@testable import RenewCore

final class ServiceLogoTests: XCTestCase {
    func testPlanAliasesResolveWithoutFuzzyMerchantMatching() {
        XCTAssertEqual(ServiceLogoCatalog.logo(for: "  ChatGPT Plus  ")?.name, "ChatGPT")
        XCTAssertEqual(ServiceLogoCatalog.logo(for: "CLAUDE PRO")?.name, "Claude")
        XCTAssertEqual(ServiceLogoCatalog.logo(for: "Claude Max")?.name, "Claude")
        XCTAssertEqual(ServiceLogoCatalog.logo(for: "Cloudflare Registrar")?.name, "Cloudflare")
        XCTAssertEqual(ServiceLogoCatalog.logo(for: "\"EVA AIRWAYS `")?.name, "EVA Air")
        XCTAssertEqual(ServiceLogoCatalog.logo(for: "personalityhub.ai")?.name, "PersonalityHub")
        for name in ["Unidentified Merchant Ltd", "Notion scam", "My Claude project", "Sunothing", "../../ChatGPT"] {
            XCTAssertNil(ServiceLogoCatalog.imageURL(for: name), name)
        }
    }

    func testPublicCatalogUsesInitialsAndRejectsUnsafePaths() throws {
        XCTAssertGreaterThan(ServiceLogoCatalog.services.count, 6000, "Directory catalog was not bundled")
        let names = Set(ServiceLogoCatalog.services.compactMap(\.asset))
        XCTAssertTrue(names.isEmpty, "Public baseline intentionally excludes uncleared third-party images")
        for asset in names {
            let url = try XCTUnwrap(ServiceLogoCatalog.imageURL(asset: asset), asset)
            let image = try XCTUnwrap(NSImage(contentsOf: url), asset)
            XCTAssertGreaterThan(image.size.width, 0, asset)
            XCTAssertLessThanOrEqual(image.size.width, 128, asset)
            XCTAssertLessThanOrEqual(image.size.height, 128, asset)
        }
        XCTAssertNil(ServiceLogoCatalog.imageURL(asset: "service-logo-../../private"))
        XCTAssertNil(ServiceLogoCatalog.imageURL(asset: "https://example.com/icon"))
    }

    func testCurrentServicesRetainAliasesAndInitialsFallback() {
        for name in ["ChatGPT", "Claude", "Anthropic", "Suno", "Vocal Image", "Meshy", "personalityhub.ai",
                     "Lalamove", "EVA AIRWAYS", "Cloudflare Registrar", "GitHub Copilot", "YouTube Premium",
                     "Google One", "Notion", "Canva", "Figma", "Slack", "Gmail", "Google Drive", "Supabase", "Stripe"] {
            XCTAssertNotNil(ServiceLogoCatalog.logo(for: name), name)
            XCTAssertNil(ServiceLogoCatalog.imageURL(for: name), name)
        }
    }

    func testBrandResolutionIsIndependentOfInterfaceLanguage() {
        let saved = L10n.language
        defer { L10n.language = saved }
        for language in AppLanguage.allCases {
            L10n.language = language
            XCTAssertNotNil(ServiceLogoCatalog.logo(for: "Claude Pro"))
            XCTAssertNil(ServiceLogoCatalog.imageURL(for: "Claude Pro"))
            XCTAssertEqual(ServiceLogoCatalog.logo(for: "YouTube Premium")?.name, "YouTube")
            XCTAssertEqual(ServiceLogoCatalog.initial(for: " 自訂工具 "), "自")
            XCTAssertEqual(ServiceLogoCatalog.initial(for: " unlisted service "), "U")
            XCTAssertEqual(ServiceLogoCatalog.initial(for: "  "), "?")
        }
    }
}
