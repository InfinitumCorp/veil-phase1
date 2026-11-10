import XCTest
@testable import Veil

final class ContentRulesTests: XCTestCase {
    func testRulesAreJSONWebKitCanCompile() throws {
        let data = try ContentRules.jsonData()
        let object = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
        XCTAssertFalse(object.isEmpty)
        for rule in object {
            let trigger = rule["trigger"] as! [String: Any]
            let action = rule["action"] as! [String: Any]
            XCTAssertFalse((trigger["url-filter"] as! String).isEmpty)
            let type = action["type"] as! String
            XCTAssertTrue(["block", "block-cookies"].contains(type))
        }
        let encoded = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(encoded.contains("block-cookies"))
        XCTAssertTrue(encoded.contains("third-party"))
        XCTAssertFalse(encoded.contains("make-https"))
        XCTAssertFalse(encoded.contains("duckduckgo"))
        XCTAssertFalse(encoded.contains("infinitum-corporation.vercel.app"))
    }

    func testKnownTrackersAreBlockedAndOrdinarySitesAreNot() {
        XCTAssertTrue(ContentRules.blocks(URL(string: "https://ad.doubleclick.net/page")!))
        XCTAssertTrue(ContentRules.blocks(URL(string: "https://www.google-analytics.com/g/collect")!))
        XCTAssertTrue(ContentRules.blocks(URL(string: "https://connect.facebook.net/en_US/fbevents.js")!))
        XCTAssertFalse(ContentRules.blocks(URL(string: "https://notdoubleclick.net/")!))
        XCTAssertFalse(ContentRules.blocks(URL(string: "https://doubleclick.net.evil.com/")!))
        XCTAssertFalse(ContentRules.blocks(URL(string: "https://example.com/?q=doubleclick.net")!))
        XCTAssertFalse(ContentRules.blocks(VeilSearch.duckDuckGoOnion))
        XCTAssertFalse(ContentRules.blocks(URL(string: "https://infinitum-corporation.vercel.app/products/veil")!))
    }

    func testReferrerScriptCannotPhoneHome() {
        let plan = WebPrivacyPlan.veil
        XCTAssertFalse(plan.persistentStore)
        XCTAssertFalse(plan.javascriptCanOpenWindowsAutomatically)
        XCTAssertTrue(plan.fraudulentWebsiteWarning)
        XCTAssertFalse(plan.siteSpecificQuirks)
        XCTAssertFalse(plan.elementFullscreen)
        XCTAssertTrue(plan.mediaPlaybackRequiresUserAction)
        XCTAssertNil(plan.customUserAgent)
        XCTAssertTrue(plan.referrerScript.contains("no-referrer"))
        XCTAssertTrue(WebPrivacyPlan.scriptIsLocal(plan.referrerScript))
        XCTAssertTrue(WebPrivacyPlan.scriptIsLocal(plan.leakScript))
        XCTAssertTrue(plan.leakScript.contains("RTCPeerConnection"))
        XCTAssertTrue(plan.leakScript.contains("webkitRTCPeerConnection"))
        XCTAssertTrue(plan.leakScript.contains("dns-prefetch"))
        XCTAssertFalse(plan.persistentStore)
    }
}
