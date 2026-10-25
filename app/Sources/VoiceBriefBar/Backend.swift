import Foundation

struct RunResult {
    let code: Int32
    let out: String
    let err: String

    var ok: Bool { code == 0 }
    var message: String {
        let text = (err.isEmpty ? out : err).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "exit \(code)" : text
    }
}

enum Paths {
    static let home = FileManager.default.homeDirectoryForCurrentUser
    static let appSupport = home.appendingPathComponent("Library/Application Support/voice-brief")
    static var venvPython: URL { appSupport.appendingPathComponent("venv/bin/python") }
    static var serverLog: URL { appSupport.appendingPathComponent("server.log") }
    static var serverPid: URL { appSupport.appendingPathComponent("server.pid") }
    static var configFile: URL { appSupport.appendingPathComponent("config.json") }

    static let pluginData = home.appendingPathComponent(".claude/plugins/data/voice-brief-voice-brief-local")
    static var daemonLog: URL { pluginData.appendingPathComponent("daemon.log") }
    static var speakerSocket: URL { pluginData.appendingPathComponent("speaker.sock") }

    static func modelCache(_ id: String) -> URL {
        home.appendingPathComponent(".cache/huggingface/hub/models--" + id.replacingOccurrences(of: "/", with: "--"))
    }

    /// Logical size of everything under `url`, following symlinks: the HF cache
    /// keeps snapshots as links into a content-addressed store, and allocated
    /// blocks (`du`) report only a few megabytes for a 4 GB model.
    static func directorySize(_ url: URL) -> Int64 {
        let manager = FileManager.default
        guard manager.fileExists(atPath: url.path),
              let enumerator = manager.enumerator(atPath: url.path) else { return 0 }

        // The HF cache keeps snapshots and blob entries as symlinks into a
        // content-addressed store shared by the whole hub, so resolve every
        // entry and count each target once.
        var seen = Set<String>()
        var total: Int64 = 0

        func add(_ path: String) {
            let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
            guard !seen.contains(resolved) else { return }
            seen.insert(resolved)
            if let attributes = try? manager.attributesOfItem(atPath: resolved),
               let size = attributes[.size] as? Int64 {
                total += size
            }
        }

        for case let relative as String in enumerator {
            add(url.appendingPathComponent(relative).path)
        }
        return total
    }
}

enum Shell {
    static var environment: [String: String] {
        var env = ProcessInfo.processInfo.environment
        let home = Paths.home.path
        let extra = [
            "/opt/homebrew/bin", "/usr/local/bin",
            "\(home)/.local/bin", "\(home)/.claude/local", "\(home)/.bun/bin",
            "/usr/bin", "/bin", "/usr/sbin", "/sbin",
        ]
        let current = env["PATH"] ?? ""
        env["PATH"] = (extra + [current]).joined(separator: ":")
        return env
    }

    static func run(_ args: [String], input: String? = nil, cwd: URL? = nil) async -> RunResult {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: args[0])
            process.arguments = Array(args.dropFirst())
            process.environment = environment
            if let cwd { process.currentDirectoryURL = cwd }

            let out = Pipe()
            let err = Pipe()
            let stdin = Pipe()
            process.standardOutput = out
            process.standardError = err
            process.standardInput = stdin

            do {
                try process.run()
            } catch {
                continuation.resume(returning: RunResult(code: -1, out: "", err: error.localizedDescription))
                return
            }

            if let input, let data = input.data(using: .utf8) {
                stdin.fileHandleForWriting.write(data)
            }
            try? stdin.fileHandleForWriting.close()

            process.terminationHandler = { finished in
                let outData = out.fileHandleForReading.readDataToEndOfFile()
                let errData = err.fileHandleForReading.readDataToEndOfFile()
                continuation.resume(returning: RunResult(
                    code: finished.terminationStatus,
                    out: String(data: outData, encoding: .utf8) ?? "",
                    err: String(data: errData, encoding: .utf8) ?? ""
                ))
            }
        }
    }

    static func zsh(_ command: String) async -> RunResult {
        await run(["/bin/zsh", "-lc", command])
    }
}

enum Presets {
    struct Preset: Identifiable, Hashable {
        let id: String
        let model: String
        let gigabytes: Double
        var title: String { id }
        var subtitle: String { "\(model.split(separator: "/").last ?? "") · ~" + String(format: "%.1f", gigabytes) + " GB" }
    }

    static let all: [Preset] = [
        Preset(id: "1.7-base", model: "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16", gigabytes: 4.3),
        Preset(id: "0.6-base", model: "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16", gigabytes: 2.3),
    ]

    static func named(_ id: String) -> Preset {
        all.first { $0.id == id } ?? all[0]
    }
}

enum Server {
    static let port = 8011

    static func isUp() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/v1/models") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    static func start() async -> String? {
        if await isUp() { return nil }
        let python = Paths.venvPython
        guard FileManager.default.isExecutableFile(atPath: python.path) else {
            return "Python environment not found. Run installer/install.sh first."
        }

        let log = Pipe()
        _ = log
        FileManager.default.createFile(atPath: Paths.serverLog.path, contents: nil)
        guard let handle = FileHandle(forWritingAtPath: Paths.serverLog.path) else {
            return "cannot open \(Paths.serverLog.path)"
        }

        let process = Process()
        process.executableURL = python
        process.arguments = ["-m", "mlx_audio.server", "--host", "127.0.0.1", "--port", String(port)]
        process.environment = Shell.environment
        process.currentDirectoryURL = Paths.appSupport
        process.standardOutput = handle
        process.standardError = handle
        process.standardInput = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            return error.localizedDescription
        }
        try? String(process.processIdentifier).write(to: Paths.serverPid, atomically: true, encoding: .utf8)
        return nil
    }

    static func stop() async {
        if let raw = try? String(contentsOf: Paths.serverPid, encoding: .utf8),
           let pid = Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)) {
            kill(pid, SIGTERM)
        }
        _ = await Shell.zsh("pkill -f mlx_audio.server || true")
        try? FileManager.default.removeItem(at: Paths.serverPid)
    }
}

enum PluginControl {
    /// The plugin payload copied into the app bundle by build.sh, so a person
    /// who installed the DMG needs no repository folder.
    static var bundledPlugin: URL? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let candidate = resources.appendingPathComponent("plugin")
        let manifest = candidate.appendingPathComponent(".claude-plugin/plugin.json")
        return FileManager.default.fileExists(atPath: manifest.path) ? candidate : nil
    }

    static func claudePath() async -> String? {
        let result = await Shell.zsh("command -v claude")
        let path = result.out.trimmingCharacters(in: .whitespacesAndNewlines)
        return result.ok && !path.isEmpty ? path : nil
    }

    static func status() async -> (installed: Bool, enabled: Bool) {
        guard let claude = await claudePath() else { return (false, false) }
        let result = await Shell.run([claude, "plugin", "list"])
        let text = result.out + result.err
        guard let range = text.range(of: "voice-brief@") else { return (false, false) }
        let tail = text[range.lowerBound...]
        let enabled = tail.contains("✔ enabled") || tail.contains("enabled")
        let disabled = tail.contains("✘ disabled")
        return (true, enabled && !disabled)
    }

    static func currentValues() async -> [String: String] {
        guard let claude = await claudePath() else { return [:] }
        let result = await Shell.run([claude, "plugin", "configure", "voice-brief@voice-brief-local", "--json"])
        guard let data = result.out.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let inputs = object["inputs"] as? [String: String] else { return [:] }
        return inputs
    }

    static func configure(_ values: [String: String]) async -> RunResult {
        guard let claude = await claudePath() else {
            return RunResult(code: -1, out: "", err: "claude CLI not found in PATH")
        }
        guard let data = try? JSONSerialization.data(withJSONObject: values),
              let payload = String(data: data, encoding: .utf8) else {
            return RunResult(code: -1, out: "", err: "bad settings payload")
        }
        return await Shell.run(
            [claude, "plugin", "configure", "voice-brief@voice-brief-local", "--values-stdin"],
            input: payload
        )
    }

    static func setEnabled(_ enabled: Bool) async -> RunResult {
        guard let claude = await claudePath() else {
            return RunResult(code: -1, out: "", err: "claude CLI not found in PATH")
        }
        return await Shell.run([claude, "plugin", enabled ? "enable" : "disable", "voice-brief"])
    }

    static func install(repo: URL) async -> RunResult {
        guard let claude = await claudePath() else {
            return RunResult(code: -1, out: "", err: "claude CLI not found in PATH")
        }
        _ = await Shell.run([claude, "plugin", "marketplace", "add", repo.path])
        let install = await Shell.run([
            claude, "plugin", "install", "voice-brief@voice-brief-local",
            "--scope", "user", "-y",
        ])
        _ = await Shell.run([claude, "plugin", "enable", "voice-brief"])
        return install
    }

    static func detectRepo() async -> URL? {
        guard let claude = await claudePath() else { return nil }
        let result = await Shell.run([claude, "plugin", "marketplace", "list"])
        for line in result.out.split(separator: "\n") {
            if line.contains("voice-brief-local") {
                let text = String(line)
                if let range = text.range(of: "Folder (") {
                    let rest = text[range.upperBound...]
                    if let end = rest.firstIndex(of: ")") {
                        return URL(fileURLWithPath: String(rest[..<end]))
                    }
                }
            }
        }
        return nil
    }
}
