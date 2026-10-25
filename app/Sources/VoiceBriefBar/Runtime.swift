import Foundation

enum Runtime {
    /// CPython shipped inside the app bundle; `swift run` has none.
    static var bundledPython: URL? {
        if let resources = Bundle.main.resourceURL {
            let candidate = resources.appendingPathComponent("python/bin/python3")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        if let override = ProcessInfo.processInfo.environment["VOICE_BRIEF_PYTHON"] {
            return URL(fileURLWithPath: override)
        }
        return nil
    }

    static var systemPython: URL? {
        for path in ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"] {
            if FileManager.default.isExecutableFile(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }
        return nil
    }

    /// A copy of the bundled runtime outside the app bundle. A venv created
    /// from the bundle would point at the .app path, so moving or renaming the
    /// app, or ejecting the DMG, would break it.
    static var installedRuntime: URL {
        Paths.appSupport.appendingPathComponent("runtime/bin/python3")
    }

    static var venvReady: Bool {
        FileManager.default.isExecutableFile(atPath: Paths.venvPython.path)
    }

    private static func ensureRuntimeCopy() throws -> URL {
        let manager = FileManager.default
        if manager.isExecutableFile(atPath: installedRuntime.path) {
            return installedRuntime
        }
        guard let bundled = bundledPython else {
            throw NSError(domain: "voice-brief", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "No bundled Python runtime"])
        }
        let source = bundled.deletingLastPathComponent().deletingLastPathComponent()
        let destination = Paths.appSupport.appendingPathComponent("runtime")
        try? manager.removeItem(at: destination)
        try manager.createDirectory(at: Paths.appSupport, withIntermediateDirectories: true)
        try manager.copyItem(at: source, to: destination)
        return installedRuntime
    }

    /// Creates the private environment and installs mlx-audio with the extras
    /// the server and transcription need. Returns nil on success.
    static func ensureVenv(log: @escaping @Sendable (String) -> Void) async -> String? {
        if venvReady { return nil }

        // A venv left broken by a moved app: remove it and start over.
        let venv = Paths.appSupport.appendingPathComponent("venv")
        if FileManager.default.fileExists(atPath: venv.path) {
            log("Repairing Python environment")
            try? FileManager.default.removeItem(at: venv)
        }

        let python: URL
        do {
            python = try ensureRuntimeCopy()
        } catch {
            guard let fallback = systemPython else { return error.localizedDescription }
            python = fallback
        }

        log("Creating Python environment")
        try? FileManager.default.createDirectory(at: Paths.appSupport, withIntermediateDirectories: true)

        var result = await Shell.run([python.path, "-m", "venv", venv.path])
        if !result.ok { return "venv failed: \(result.message)" }

        log("Installing Python packages")
        result = await Shell.run([Paths.venvPython.path, "-m", "pip", "install", "--quiet", "--upgrade", "pip"])
        if !result.ok { return "pip upgrade failed: \(result.message)" }

        log("Installing mlx-audio (this takes a minute)")
        result = await Shell.run([
            Paths.venvPython.path, "-m", "pip", "install", "--quiet", "--upgrade",
            "mlx-audio[server,stt,tts]",
        ])
        if !result.ok {
            log("PyPI install failed, trying GitHub")
            result = await Shell.run([
                Paths.venvPython.path, "-m", "pip", "install", "--quiet", "--upgrade",
                "mlx-audio[server,stt,tts] @ git+https://github.com/Blaizzy/mlx-audio",
            ])
        }
        if !result.ok { return "mlx-audio install failed: \(result.message)" }

        log("Environment ready")
        return nil
    }
}
