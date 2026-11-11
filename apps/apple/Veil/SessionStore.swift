import Foundation

struct Bookmark: Identifiable, Codable, Equatable {
    var id: UUID
    var title: String
    var url: URL
}

struct HistoryEntry: Identifiable, Codable, Equatable {
    var id: UUID
    var title: String
    var url: URL
    var visitedAt: Date
}

protocol SessionPersisting: AnyObject {
    func load() -> (bookmarks: [Bookmark], history: [HistoryEntry])
    func save(bookmarks: [Bookmark], history: [HistoryEntry])
    func wipe()
}

final class MemorySessionPersistence: SessionPersisting {
    func load() -> (bookmarks: [Bookmark], history: [HistoryEntry]) { ([], []) }
    func save(bookmarks: [Bookmark], history: [HistoryEntry]) {}
    func wipe() {}
}

enum SessionPaths {
    static func isWipeable(_ url: URL) -> Bool {
        let name = url.resolvingSymlinksInPath().standardizedFileURL.lastPathComponent
        return name == "VEIL" || name == "VEILDownloads"
    }
}

final class FileSessionPersistence: SessionPersisting {
    let directory: URL
    private let bookmarksURL: URL
    private let historyURL: URL
    private let fileManager: FileManager

    init(directory: URL, fileManager: FileManager = .default) {
        self.directory = directory
        bookmarksURL = directory.appendingPathComponent("bookmarks.json")
        historyURL = directory.appendingPathComponent("history.json")
        self.fileManager = fileManager
    }

    func load() -> (bookmarks: [Bookmark], history: [HistoryEntry]) {
        (
            decode([Bookmark].self, from: bookmarksURL) ?? [],
            decode([HistoryEntry].self, from: historyURL) ?? []
        )
    }

    func save(bookmarks: [Bookmark], history: [HistoryEntry]) {
        guard SessionPaths.isWipeable(directory) else { return }
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        write(bookmarks, to: bookmarksURL)
        write(history, to: historyURL)
    }

    func wipe() {
        guard SessionPaths.isWipeable(directory) else { return }
        try? fileManager.removeItem(at: directory)
    }

    private func decode<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private func write<T: Encodable>(_ value: T, to url: URL) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

@MainActor
final class SessionStore {
    static let historyCap = 500
    private var persistence: SessionPersisting
    private(set) var bookmarks: [Bookmark] = []
    private(set) var history: [HistoryEntry] = []
    private var persists: Bool

    init(persistence: SessionPersisting, persists: Bool) {
        self.persistence = persistence
        self.persists = persists
        if persists {
            let loaded = persistence.load()
            bookmarks = loaded.bookmarks
            history = loaded.history
        } else {
            persistence.wipe()
        }
    }

    func setPersists(_ persists: Bool) {
        self.persists = persists
        if persists {
            persistence.save(bookmarks: bookmarks, history: history)
        } else {
            persistence.wipe()
        }
    }

    func addBookmark(title: String, url: URL) {
        bookmarks.removeAll { $0.url == url }
        bookmarks.insert(Bookmark(id: UUID(), title: title.isEmpty ? url.absoluteString : title, url: url), at: 0)
        saveIfNeeded()
    }

    func removeBookmark(url: URL) {
        bookmarks.removeAll { $0.url == url }
        saveIfNeeded()
    }

    func recordVisit(title: String, url: URL, at date: Date = Date()) {
        history.insert(HistoryEntry(id: UUID(), title: title.isEmpty ? (url.host ?? url.absoluteString) : title, url: url, visitedAt: date), at: 0)
        if history.count > Self.historyCap {
            history = Array(history.prefix(Self.historyCap))
        }
        saveIfNeeded()
    }

    func clearHistory() {
        history = []
        saveIfNeeded()
    }

    var startPageBookmarks: [Bookmark] { Array(bookmarks.prefix(12)) }

    private func saveIfNeeded() {
        if persists {
            persistence.save(bookmarks: bookmarks, history: history)
        }
    }
}

enum DownloadDirectory {
    static let folderName = "VEILDownloads"

    static func directory(fileManager: FileManager = .default) -> URL {
        fileManager.temporaryDirectory.appendingPathComponent(folderName, isDirectory: true)
    }

    static func sanitize(_ name: String) -> String {
        let base = URL(fileURLWithPath: name).lastPathComponent
        let scalars = base.unicodeScalars.map { scalar -> Character in
            let value = scalar.value
            let allowed = (48...57).contains(value) || (65...90).contains(value) || (97...122).contains(value) || value == 46 || value == 95 || value == 45 || value == 32
            return allowed ? Character(scalar) : "_"
        }
        var cleaned = String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned == "." || cleaned == ".." || cleaned.isEmpty { cleaned = "download" }
        if cleaned.count > 120 { cleaned = String(cleaned.prefix(120)) }
        return cleaned
    }

    static func uniqueDestination(directory: URL, suggested: String, exists: (URL) -> Bool) -> URL {
        let clean = sanitize(suggested)
        let url = URL(fileURLWithPath: clean)
        let stem = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        var candidate = directory.appendingPathComponent(clean)
        var index = 2
        while exists(candidate) {
            let name = ext.isEmpty ? "\(stem)-\(index)" : "\(stem)-\(index).\(ext)"
            candidate = directory.appendingPathComponent(name)
            index += 1
            if index > 500 { break }
        }
        return candidate
    }

    static func wipe(_ url: URL, fileManager: FileManager = .default) {
        guard SessionPaths.isWipeable(url) else { return }
        try? fileManager.removeItem(at: url)
    }
}
