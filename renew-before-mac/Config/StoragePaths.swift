import Foundation

/// Both processes use this URL. Only the app creates the folder or writes the ledger.
enum StoragePaths {
    static func recordsURL() throws -> URL {
        let info = Bundle.main.infoDictionary
        let directory: URL
        if let group = info?["RenewBeforeAppGroup"] as? String, !group.isEmpty {
            guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
                throw CocoaError(.fileReadNoPermission)
            }
            directory = url
        } else {
            // In a sandbox `homeDirectoryForCurrentUser` returns the process's own container.
            // Resolve the user's actual home for the narrowly entitled local-development folder.
            guard let user = getpwuid(getuid()), let home = user.pointee.pw_dir else {
                throw CocoaError(.fileReadUnknown)
            }
            directory = URL(fileURLWithPath: String(cString: home), isDirectory: true)
                .appendingPathComponent("Library/Application Support/Renew Before Local", isDirectory: true)
        }
        return directory.appendingPathComponent("records.json")
    }
}
