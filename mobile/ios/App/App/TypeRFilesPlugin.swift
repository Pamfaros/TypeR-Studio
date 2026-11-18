import Capacitor
import Foundation
import UIKit
import UniformTypeIdentifiers

// The files of the user, for the page (web/mobile.js). A browser on a phone only hands out copies
// of files; here they are opened where they are, in Files, iCloud Drive or another app's folder,
// and the right to come back to them is kept: Save writes over the file that was opened.
//
// The page never gets a path. It gets a token: the bookmark the system gives for a file or a
// folder the user picked, with the way down to a file inside a picked folder when there is one.
// Only what the user picked, and what lies in a folder they picked, can be reached with one.

@objc(TypeRFilesPlugin)
public class TypeRFilesPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "TypeRFilesPlugin"
    public let jsName = "TypeRFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        "pickFiles", "pickFolder", "createFile", "stat", "read", "release", "writeBegin", "writeChunk", "writeEnd", "writeAbort",
        "access", "same", "list", "child", "resolve", "opened", "setBackground"
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    private enum Failure: Error {
        case notFound(String)
        case denied(String)
        case mismatch(String)
        case unreadable(String)

        var code: String {
            switch self {
            case .notFound: return "NOT_FOUND"
            case .denied: return "DENIED"
            case .mismatch: return "MISMATCH"
            case .unreadable: return "UNREADABLE"
            }
        }
        var message: String {
            switch self {
            case .notFound(let text), .denied(let text), .mismatch(let text), .unreadable(let text): return text
            }
        }
    }

    private let work = DispatchQueue(label: "fr.scanr.typerstudio.files", qos: .userInitiated)
    private let files = FileManager.default
    private var picking: (call: CAPPluginCall, kind: String, staged: URL?)?
    private var writes: [String: (handle: FileHandle, temporary: URL, token: String)] = [:]

    // What the system asked the app to open before the page was there to take it
    private static var waiting: [[String: Any]] = []
    private static weak var loaded: TypeRFilesPlugin?

    override public func load() {
        TypeRFilesPlugin.loaded = self
        try? files.removeItem(at: scratch("read"))
        try? files.removeItem(at: scratch("write"))
        try? files.removeItem(at: scratch("new"))
    }

    private func scratch(_ name: String) -> URL {
        files.temporaryDirectory.appendingPathComponent("typer-\(name)", isDirectory: true)
    }

    private func fail(_ call: CAPPluginCall, _ error: Error) {
        if let failure = error as? Failure {
            call.reject(failure.message, failure.code)
        } else {
            let known = error as NSError
            let missing = known.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(known.code)
            let refused = known.domain == NSCocoaErrorDomain && [NSFileReadNoPermissionError, NSFileWriteNoPermissionError].contains(known.code)
            call.reject(error.localizedDescription, missing ? "NOT_FOUND" : refused ? "DENIED" : nil)
        }
    }

    /* ---------------------------------- tokens ---------------------------------- */

    private static func token(of url: URL) throws -> String {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil).base64EncodedString()
    }

    // The file or folder of a token, reachable for as long as `run` lasts
    private func with<T>(_ token: String?, _ run: (URL) throws -> T) throws -> T {
        guard let token = token, !token.isEmpty else { throw Failure.notFound("No file.") }
        let parts = token.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
        guard let bookmark = Data(base64Encoded: String(parts[0])) else { throw Failure.notFound("Not a file of this app.") }
        var stale = false
        let base: URL
        do {
            base = try URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        } catch {
            throw Failure.notFound("This file can't be found any more.")
        }
        let scoped = base.startAccessingSecurityScopedResource()
        defer { if scoped { base.stopAccessingSecurityScopedResource() } }
        var url = base
        if parts.count > 1 {
            for name in parts[1].split(separator: "/") {
                guard name != ".." && name != "." else { throw Failure.denied("Refused path.") }
                url.appendPathComponent(String(name))
            }
        }
        return try run(url)
    }

    private func inside(_ token: String, _ name: String) -> String {
        token.contains("|") ? "\(token)/\(name)" : "\(token)|\(name)"
    }

    private func isFolder(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
    }

    private func facts(_ url: URL) throws -> [String: Any] {
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .isDirectoryKey])
        return [
            "name": url.lastPathComponent,
            "size": values.fileSize ?? 0,
            "modified": Int(((values.contentModificationDate ?? Date(timeIntervalSince1970: 0)).timeIntervalSince1970 * 1000).rounded()),
            "kind": (values.isDirectory ?? false) ? "directory" : "file"
        ]
    }

    private func coordinated(reading url: URL, _ run: (URL) throws -> Void) throws {
        var failure: Error?
        var refused: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &refused) { place in
            do { try run(place) } catch { failure = error }
        }
        if let error = refused ?? failure { throw error }
    }

    /* ---------------------------------- pickers --------------------------------- */

    private func present(_ picker: UIDocumentPickerViewController, _ call: CAPPluginCall, kind: String, staged: URL? = nil) {
        if let waitingCall = picking?.call { waitingCall.reject("Another picker took over.", "ABORT") }
        picking = (call, kind, staged)
        picker.delegate = self
        if let near = call.getString("near"), let folder = try? with(near, { self.isFolder($0) ? $0 : $0.deletingLastPathComponent() }) {
            picker.directoryURL = folder
        }
        guard let host = bridge?.viewController else {
            picking = nil
            call.reject("No window.")
            return
        }
        host.present(picker, animated: true)
    }

    @objc func pickFiles(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: false)
            picker.allowsMultipleSelection = call.getBool("multiple") ?? false
            self.present(picker, call, kind: "file")
        }
    }

    @objc func pickFolder(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.present(UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false), call, kind: "directory")
        }
    }

    // Save As: the system's own sheet moves an empty file where the user says, and that file is
    // then written like any other
    @objc func createFile(_ call: CAPPluginCall) {
        let name = (call.getString("name") ?? "Untitled").replacingOccurrences(of: "/", with: "-")
        let folder = scratch("new").appendingPathComponent(UUID().uuidString, isDirectory: true)
        let staged = folder.appendingPathComponent(name)
        do {
            try files.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data().write(to: staged)
        } catch {
            fail(call, error)
            return
        }
        DispatchQueue.main.async {
            self.present(UIDocumentPickerViewController(forExporting: [staged], asCopy: false), call, kind: "new", staged: folder)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let (call, kind, staged) = picking else { return }
        picking = nil
        work.async {
            defer { if let staged = staged { try? self.files.removeItem(at: staged) } }
            do {
                let picked = try urls.map { url -> [String: Any] in
                    ["kind": kind == "directory" ? "directory" : "file", "name": url.lastPathComponent, "token": try TypeRFilesPlugin.token(of: url)]
                }
                guard let first = picked.first else {
                    call.reject("Nothing was picked.", "ABORT")
                    return
                }
                call.resolve(kind == "file" ? ["files": picked] : first)
            } catch {
                self.fail(call, error)
            }
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let (call, _, staged) = picking else { return }
        picking = nil
        if let staged = staged { try? files.removeItem(at: staged) }
        call.reject("Cancelled.", "ABORT")
    }

    /* ---------------------------------- reading --------------------------------- */

    @objc func stat(_ call: CAPPluginCall) {
        work.async {
            do { call.resolve(try self.with(call.getString("token")) { try self.facts($0) }) } catch { self.fail(call, error) }
        }
    }

    // A copy the page reads through the app's own address, then lets go (release). On the same
    // disk a copy takes no room and no time; a file still in the cloud comes down first.
    @objc func read(_ call: CAPPluginCall) {
        work.async {
            do {
                let folder = self.scratch("read").appendingPathComponent(UUID().uuidString, isDirectory: true)
                try self.files.createDirectory(at: folder, withIntermediateDirectories: true)
                let path = try self.with(call.getString("token")) { url -> String in
                    let copy = folder.appendingPathComponent(url.lastPathComponent)
                    try self.coordinated(reading: url) { try self.files.copyItem(at: $0, to: copy) }
                    return copy.path
                }
                call.resolve(["path": path])
            } catch {
                self.fail(call, error)
            }
        }
    }

    @objc func release(_ call: CAPPluginCall) {
        work.async {
            if let path = call.getString("path") {
                let folder = URL(fileURLWithPath: path).deletingLastPathComponent().standardizedFileURL
                if folder.deletingLastPathComponent().path == self.scratch("read").standardizedFileURL.path { try? self.files.removeItem(at: folder) }
            }
            call.resolve()
        }
    }

    /* ---------------------------------- writing --------------------------------- */

    @objc func writeBegin(_ call: CAPPluginCall) {
        work.async {
            do {
                let token = call.getString("token") ?? ""
                try self.with(token) { url in
                    if self.isFolder(url) { throw Failure.mismatch("This is a folder.") }
                }
                let id = UUID().uuidString
                let temporary = self.scratch("write").appendingPathComponent(id)
                try self.files.createDirectory(at: temporary.deletingLastPathComponent(), withIntermediateDirectories: true)
                guard self.files.createFile(atPath: temporary.path, contents: nil) else { throw Failure.denied("No room to write.") }
                self.writes[id] = (try FileHandle(forWritingTo: temporary), temporary, token)
                call.resolve(["id": id])
            } catch {
                self.fail(call, error)
            }
        }
    }

    @objc func writeChunk(_ call: CAPPluginCall) {
        work.async {
            guard let id = call.getString("id"), let write = self.writes[id], let data = Data(base64Encoded: call.getString("data") ?? "") else {
                call.reject("No such write.")
                return
            }
            do {
                try write.handle.write(contentsOf: data)
                call.resolve()
            } catch {
                self.fail(call, error)
            }
        }
    }

    // The file is written over where it is, so that it stays the same file for the system: a
    // new file in its place would no longer be the one the user gave the app. What it held is
    // set aside first, and put back if the writing fails halfway.
    @objc func writeEnd(_ call: CAPPluginCall) {
        work.async {
            guard let id = call.getString("id"), let write = self.writes.removeValue(forKey: id) else {
                call.reject("No such write.")
                return
            }
            let backup = write.temporary.appendingPathExtension("before")
            defer {
                try? self.files.removeItem(at: write.temporary)
                try? self.files.removeItem(at: backup)
            }
            do {
                try write.handle.close()
                let facts = try self.with(write.token) { url -> [String: Any] in
                    var failure: Error?
                    var refused: NSError?
                    NSFileCoordinator().coordinate(writingItemAt: url, options: [], error: &refused) { place in
                        do {
                            let kept = (try? self.files.copyItem(at: place, to: backup)) != nil
                            do {
                                try self.pour(write.temporary, into: place)
                            } catch {
                                if kept { try? self.pour(backup, into: place) }
                                throw error
                            }
                        } catch {
                            failure = error
                        }
                    }
                    if let error = refused ?? failure { throw error }
                    return try self.facts(url)
                }
                call.resolve(facts)
            } catch {
                self.fail(call, error)
            }
        }
    }

    private func pour(_ source: URL, into place: URL) throws {
        if !files.fileExists(atPath: place.path) { files.createFile(atPath: place.path, contents: nil) }
        let from = try FileHandle(forReadingFrom: source)
        defer { try? from.close() }
        let to = try FileHandle(forWritingTo: place)
        defer { try? to.close() }
        try to.truncate(atOffset: 0)
        while let data = try from.read(upToCount: 1 << 20), !data.isEmpty {
            try to.write(contentsOf: data)
        }
        try to.synchronize()
    }

    @objc func writeAbort(_ call: CAPPluginCall) {
        work.async {
            if let id = call.getString("id"), let write = self.writes.removeValue(forKey: id) {
                try? write.handle.close()
                try? self.files.removeItem(at: write.temporary)
            }
            call.resolve()
        }
    }

    /* ---------------------------------- folders --------------------------------- */

    @objc func access(_ call: CAPPluginCall) {
        work.async {
            let write = call.getBool("write") ?? false
            let granted = (try? self.with(call.getString("token")) { url in
                write ? self.files.isWritableFile(atPath: url.path) : self.files.isReadableFile(atPath: url.path)
            }) ?? false
            call.resolve(["granted": granted])
        }
    }

    private func realPath(_ url: URL) -> String {
        url.standardizedFileURL.resolvingSymlinksInPath().path
    }

    @objc func same(_ call: CAPPluginCall) {
        work.async {
            let a = try? self.with(call.getString("a")) { self.realPath($0) }
            let b = try? self.with(call.getString("b")) { self.realPath($0) }
            call.resolve(["same": a != nil && a == b])
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        work.async {
            do {
                let token = call.getString("token") ?? ""
                let entries = try self.with(token) { folder -> [[String: Any]] in
                    var found: [URL] = []
                    try self.coordinated(reading: folder) { found = try self.files.contentsOfDirectory(at: $0, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) }
                    return found.map { ["kind": self.isFolder($0) ? "directory" : "file", "name": $0.lastPathComponent, "token": self.inside(token, $0.lastPathComponent)] }
                }
                call.resolve(["entries": entries])
            } catch {
                self.fail(call, error)
            }
        }
    }

    @objc func child(_ call: CAPPluginCall) {
        work.async {
            do {
                let token = call.getString("token") ?? ""
                let name = call.getString("name") ?? ""
                let wanted = call.getString("kind") == "directory"
                guard !name.isEmpty, !name.contains("/"), name != "..", name != "." else { throw Failure.denied("Refused name.") }
                try self.with(token) { folder in
                    let url = folder.appendingPathComponent(name)
                    var isDirectory: ObjCBool = false
                    if self.files.fileExists(atPath: url.path, isDirectory: &isDirectory) {
                        if isDirectory.boolValue != wanted { throw Failure.mismatch("\(name) is not a \(wanted ? "folder" : "file").") }
                    } else if call.getBool("create") ?? false {
                        if wanted {
                            try self.files.createDirectory(at: url, withIntermediateDirectories: false)
                        } else {
                            try Data().write(to: url)
                        }
                    } else {
                        throw Failure.notFound("\(name) is not in this folder.")
                    }
                }
                call.resolve(["kind": wanted ? "directory" : "file", "name": name, "token": self.inside(token, name)])
            } catch {
                self.fail(call, error)
            }
        }
    }

    @objc func resolve(_ call: CAPPluginCall) {
        work.async {
            let folder = try? self.with(call.getString("token")) { self.realPath($0) }
            let inner = try? self.with(call.getString("child")) { self.realPath($0) }
            if let folder = folder, let inner = inner, inner.hasPrefix(folder + "/") {
                call.resolve(["path": inner.dropFirst(folder.count + 1).split(separator: "/").map(String.init)])
            } else {
                call.resolve([:])
            }
        }
    }

    /* --------------------------- opened from another app -------------------------- */

    // « Open in TypeR Studio » in Files, or a file handed over by another app. In place, Save
    // will write over it; a copy left in the app's inbox is only read.
    static func open(_ url: URL, inPlace: Bool) {
        guard url.isFileURL, let token = try? token(of: url) else { return }
        let file: [String: Any] = ["name": url.lastPathComponent, "token": token, "lasting": inPlace]
        if let plugin = loaded, plugin.hasListeners("open") {
            plugin.notifyListeners("open", data: ["files": [file]])
        } else {
            waiting.append(file)
        }
    }

    @objc func opened(_ call: CAPPluginCall) {
        let files = TypeRFilesPlugin.waiting
        TypeRFilesPlugin.waiting = []
        call.resolve(["files": files])
    }

    /* ----------------------------------- looks ---------------------------------- */

    // What shows around the page (behind the clock, while the page turns) takes the theme's colour
    @objc func setBackground(_ call: CAPPluginCall) {
        guard let color = UIColor.capacitor.color(fromHex: call.getString("color") ?? "") else {
            call.resolve()
            return
        }
        DispatchQueue.main.async {
            self.bridge?.viewController?.view.backgroundColor = color
            self.bridge?.webView?.backgroundColor = color
            self.bridge?.webView?.scrollView.backgroundColor = color
            self.bridge?.viewController?.view.window?.backgroundColor = color
            call.resolve()
        }
    }
}
