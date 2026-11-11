import XCTest
@testable import Veil

enum RepoPaths {
    static var root: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    static var apple: URL {
        root.appendingPathComponent("apps/apple", isDirectory: true)
    }
}

func fixtureRegistry(apps: [[String: Any]] = [
    ["id": "cndctr", "name": "/CNDCTR/™", "summary": "AI coding & execution workspace", "url": "https://apps.example/cndctr", "panel": true],
    ["id": "scalvs", "name": "SCALVS.ai™", "summary": "AI workforce platform", "url": "https://apps.example/scalus#old", "panel": true],
]) throws -> (AppRegistry, [String: Any]) {
    let object: [String: Any] = [
        "schema": 1,
        "version": 1,
        "signin": ["label": "Sign In", "url": "https://id.example/signin"],
        "mail": ["label": "Mail", "url": "https://mail.example/"],
        "apps": apps,
    ]
    let data = try JSONSerialization.data(withJSONObject: object)
    return (try AppRegistry.load(data: data), object)
}
