import XCTest
@testable import VeilLogic

final class TorLogicTests: XCTestCase {
    func testFailClosedGateAndProxyConfiguration() throws {
        try TorLogicChecks.run()
    }
}
