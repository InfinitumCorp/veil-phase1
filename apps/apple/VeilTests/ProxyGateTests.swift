import XCTest
@testable import Veil

final class ProxyGateTests: XCTestCase {
    func testFailClosedGateAndProxyConfiguration() throws {
        try TorLogicChecks.run()
    }
}
