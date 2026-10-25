import AppKit
import Foundation

enum Action: String {
    case prepare, start, stop, restart, download, remove, clone, install, enable
}

@MainActor
final class AppState: ObservableObject {
    @Published var serverUp = false
    @Published var venvReady = false
    @Published var pluginInstalled = false
    @Published var pluginEnabled = false

    @Published var presetID = "1.7-base"
    @Published var voiceMode = "bundled"
    @Published var refAudio = "none"
    @Published var language = "auto"
    @Published var autostart = true
    @Published var announce = true

    @Published var action: Action?
    @Published var actionLabel: String?
    @Published var notice: String?
    @Published var errorText: String?

    @Published var modelBytes: [String: Int64] = [:]
    @Published var downloadedGB: Double = 0
    @Published var downloadFraction: Double?

    @Published var repo: URL?

    private var ticking = false

    init() {
        // Set before the first poll so the panel does not flash "first start".
        venvReady = Runtime.venvReady
        Task { await bootstrap() }
        Task { await tick() }
    }

    var busy: Bool { action != nil }

    var repoLabel: String {
        guard let repo else { return "Plugin payload missing" }
        if repo.path.contains(".app/Contents/Resources/plugin") { return "Bundled payload" }
        return repo.lastPathComponent
    }

    // MARK: - lifecycle

    private func bootstrap() async {
        if let bundled = PluginControl.bundledPlugin {
            repo = bundled
        } else {
            repo = await PluginControl.detectRepo()
        }
        venvReady = Runtime.venvReady
        await loadSettings()
        await refreshStatus()
    }

    private func tick() async {
        guard !ticking else { return }
        ticking = true
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(3))
            await refreshStatus()
        }
    }

    func refreshStatus() async {
        async let up = Server.isUp()
        async let status = PluginControl.status()
        let (server, plugin) = await (up, status)
        serverUp = server
        pluginInstalled = plugin.installed
        pluginEnabled = plugin.enabled
        venvReady = Runtime.venvReady
        modelBytes = await Task.detached {
            var sizes: [String: Int64] = [:]
            for preset in Presets.all {
                sizes[preset.id] = Paths.directorySize(Paths.modelCache(preset.model))
            }
            return sizes
        }.value
    }

    private func loadSettings() async {
        var values = await PluginControl.currentValues()

        if values.isEmpty,
           let data = try? Data(contentsOf: Paths.configFile),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            values = object
        }

        if let preset = values["modelPreset"], !preset.isEmpty { presetID = preset }
        if let audio = values["refAudio"] {
            refAudio = audio
            voiceMode = (audio == "none" || audio.isEmpty) ? "bundled" : "clone"
        }
        if let lang = values["language"], !lang.isEmpty { language = lang }
        if let auto = values["autostart"] { autostart = auto != "0" }
        if let ann = values["announceProject"] { announce = ann != "0" }
    }

    // MARK: - model state

    func installedGB(_ preset: Presets.Preset) -> Double {
        Double(modelBytes[preset.id] ?? 0) / 1_000_000_000
    }

    func isInstalled(_ preset: Presets.Preset) -> Bool {
        installedGB(preset) >= preset.gigabytes * 0.85
    }

    // MARK: - settings

    func applySettings() async {
        let values: [String: String] = [
            "engine": "mlx",
            "ttsUrl": "http://127.0.0.1:\(Server.port)",
            "sampleRate": "24000",
            "modelPreset": presetID,
            "refAudio": voiceMode == "bundled" ? "none" : refAudio,
            "refText": voiceMode == "bundled" ? "none" : currentRefText(),
            "autostart": autostart ? "1" : "0",
            "announceProject": announce ? "1" : "0",
            "language": language,
        ]

        let result = await PluginControl.configure(values)
        if result.ok {
            notice = "Settings saved"
            errorText = nil
        } else {
            errorText = result.message
        }
    }

    private func currentRefText() -> String {
        guard refAudio != "none" else { return "none" }
        let folder = URL(fileURLWithPath: refAudio).deletingLastPathComponent()
        let textFile = folder.appendingPathComponent("ref.txt")
        if let text = try? String(contentsOf: textFile, encoding: .utf8) {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return "none"
    }

    // MARK: - actions

    func prepareEnvironment() async {
        guard !Runtime.venvReady else { return }
        action = .prepare
        actionLabel = "Preparing Python"
        let error = await Runtime.ensureVenv { message in
            Task { @MainActor in self.actionLabel = message }
        }
        action = nil
        actionLabel = nil
        if let error {
            errorText = error
        } else {
            venvReady = true
            notice = "Python environment ready"
        }
    }

    func startServer() async {
        if !Runtime.venvReady {
            await prepareEnvironment()
            if !Runtime.venvReady { return }
        }
        action = .start
        if let error = await Server.start() {
            errorText = error
        } else {
            notice = "Server starting"
            errorText = nil
        }
        try? await Task.sleep(for: .seconds(2))
        await refreshStatus()
        action = nil
    }

    func stopServer() async {
        action = .stop
        await Server.stop()
        try? await Task.sleep(for: .milliseconds(600))
        await refreshStatus()
        action = nil
    }

    func restartServer() async {
        action = .restart
        await Server.stop()
        try? await Task.sleep(for: .milliseconds(500))
        if !Runtime.venvReady { await prepareEnvironment() }
        if let error = await Server.start() {
            errorText = error
        } else {
            notice = "Server restarting"
            errorText = nil
        }
        try? await Task.sleep(for: .seconds(2))
        await refreshStatus()
        action = nil
    }

    func downloadModel() async {
        if !Runtime.venvReady {
            await prepareEnvironment()
            if !Runtime.venvReady { return }
        }

        let preset = Presets.named(presetID)
        let cache = Paths.modelCache(preset.model)
        downloadedGB = installedGB(preset)
        downloadFraction = min(0.99, downloadedGB / preset.gigabytes)
        action = .download

        let code = "from huggingface_hub import snapshot_download;snapshot_download('\(preset.model)')"
        let done = Flag()
        let task = Task.detached {
            let result = await Shell.run([Paths.venvPython.path, "-c", code])
            done.value = true
            return result
        }

        while !done.value {
            downloadedGB = Double(Paths.directorySize(cache)) / 1_000_000_000
            downloadFraction = min(0.99, downloadedGB / preset.gigabytes)
            try? await Task.sleep(for: .milliseconds(700))
        }

        let result = await task.value
        downloadedGB = Double(Paths.directorySize(cache)) / 1_000_000_000
        downloadFraction = nil
        action = nil
        await refreshStatus()
        if result.ok {
            notice = "Model \(preset.id) ready"
        } else {
            errorText = result.message
        }
    }

    func removeModel() async {
        let preset = Presets.named(presetID)
        action = .remove
        try? FileManager.default.removeItem(at: Paths.modelCache(preset.model))
        await refreshStatus()
        notice = "Model \(preset.id) removed"
        action = nil
    }

    func cloneVoice(from url: URL) async {
        if !Runtime.venvReady {
            await prepareEnvironment()
            if !Runtime.venvReady { return }
        }
        action = .clone
        actionLabel = "Cleaning reference"
        let name = url.deletingPathExtension().lastPathComponent
            .replacingOccurrences(of: " ", with: "-")
        do {
            let built = try await VoiceSetup.buildReference(from: url, name: name) { message in
                Task { @MainActor in self.actionLabel = message }
            }
            voiceMode = "clone"
            refAudio = built.wav.path
            action = nil
            actionLabel = nil
            await applySettings()
            notice = "Voice cloned from \(url.lastPathComponent)"
        } catch {
            action = nil
            actionLabel = nil
            errorText = error.localizedDescription
        }
    }

    func installPlugin() async {
        guard let repo else {
            errorText = "Plugin payload missing from the app bundle."
            return
        }
        action = .install
        let result = await PluginControl.install(repo: repo)
        action = nil
        if result.ok {
            notice = "Plugin installed"
            await refreshStatus()
            await applySettings()
        } else {
            errorText = result.message
        }
    }

    func setPlugin(enabled: Bool) async {
        action = .enable
        let result = await PluginControl.setEnabled(enabled)
        action = nil
        if result.ok {
            await refreshStatus()
        } else {
            errorText = result.message
        }
    }

    func chooseRepo() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Use repository"
        NSApp.activate(ignoringOtherApps: true)
        if panel.runModal() == .OK, let url = panel.url {
            repo = url
        }
    }

    func chooseVoiceFile() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.audio, .movie]
        panel.prompt = "Clone voice"
        NSApp.activate(ignoringOtherApps: true)
        if panel.runModal() == .OK, let url = panel.url {
            Task { await cloneVoice(from: url) }
        }
    }

    func openDaemonLog() { NSWorkspace.shared.open(Paths.daemonLog) }
    func openServerLog() { NSWorkspace.shared.open(Paths.serverLog) }
}

final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = false

    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}
