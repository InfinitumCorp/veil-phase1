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
        // macOS puts a SwiftUI Text's string in value, iOS in label.
        let known = NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "Tor", "Tor")
        expectation(for: known, evaluatedWith: status)
        waitForExpectations(timeout: 10)
        XCTAssertEqual(app.webViews.count, 0)
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
        if !settings.waitForExistence(timeout: 5) { print("VEIL-UI-TREE\n" + app.debugDescription) }
        XCTAssertTrue(settings.exists)
        settings.tap()
        XCTAssertTrue(app.staticTexts["Wipe on close"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["HTTPS-only"].exists)
    }
}
