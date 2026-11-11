import XCTest

final class StartPageSmokeTests: XCTestCase {
    func testLaunchShowsTheVeilStartPage() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["VEIL</>"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.textFields["start.search"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Anonymous"].exists)
        XCTAssertTrue(app.buttons["Sign In"].exists)
        XCTAssertTrue(app.buttons["Mail"].exists)
        XCTAssertTrue(app.buttons["Apps"].exists)
        XCTAssertTrue(app.staticTexts["AI-powered. Blockchain-governed™."].exists)
        XCTAssertTrue(app.staticTexts["© 2026 Infinitum Corporation"].exists)
        let status = app.staticTexts["tor.status"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        let paused = NSPredicate(format: "label CONTAINS %@", "Not connected to Tor")
        expectation(for: paused, evaluatedWith: status)
        waitForExpectations(timeout: 20)
    }

    func testNewTabAndSettings() {
        let app = XCUIApplication()
        app.launch()
        let newTab = app.buttons["tabs.new"]
        XCTAssertTrue(newTab.waitForExistence(timeout: 15))
        newTab.tap()
        XCTAssertTrue(app.staticTexts["VEIL</>"].exists)
        app.buttons["toolbar.menu"].tap()
        let settings = app.buttons["menu.settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.staticTexts["Wipe on close"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["HTTPS-only"].exists)
    }
}
