import AppKit
import SwiftUI

struct PanelView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        ZStack {
            VisualEffect(material: .popover, blending: .behindWindow)
                .ignoresSafeArea()

            GlassEffectContainer(spacing: 12) {
                VStack(alignment: .leading, spacing: 12) {
                    header
                    serverCard
                    modelCard
                    voiceCard
                    optionsCard
                    pluginCard
                    footer
                }
                .padding(16)
            }
        }
        .frame(width: 388)
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
    }

    // MARK: - header

    private var header: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(.tint.opacity(0.18))
                .frame(width: 36, height: 36)
                .overlay {
                    Image(systemName: "waveform")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.tint)
                }

            VStack(alignment: .leading, spacing: 1) {
                Text("Claude Voice")
                    .font(.system(size: 14, weight: .semibold))
                Text(state.serverUp ? "Speaking through Qwen" : "Server is stopped")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            StatusPill(text: state.serverUp ? "Online" : "Offline",
                       color: state.serverUp ? .green : .secondary)
        }
        .padding(.horizontal, 2)
    }

    // MARK: - server

    private var serverCard: some View {
        Card(title: "Server", icon: "bolt.horizontal.circle") {
            HStack(spacing: 6) {
                PillButton(title: "Start", icon: "play.fill", active: state.action == .start) {
                    Task { await state.startServer() }
                }
                .disabled(state.serverUp || state.busy)

                PillButton(title: "Stop", icon: "stop.fill", active: state.action == .stop) {
                    Task { await state.stopServer() }
                }
                .disabled(!state.serverUp || state.busy)

                PillButton(title: "Restart", icon: "arrow.clockwise", active: state.action == .restart) {
                    Task { await state.restartServer() }
                }
                .disabled(state.busy)

                Spacer()

                IconButton(system: "doc.text.magnifyingglass", help: "Server log") {
                    state.openServerLog()
                }
            }

            if !state.venvReady {
                Text("First start installs a private Python environment (about a minute).")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - model

    private var modelCard: some View {
        Card(title: "Model", icon: "brain.head.profile") {
            Picker("", selection: $state.presetID) {
                ForEach(Presets.all) { preset in
                    Text(preset.id).tag(preset.id)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .onChange(of: state.presetID) { _, _ in
                Task { await state.applySettings() }
            }

            let preset = Presets.named(state.presetID)
            let installed = state.isInstalled(preset)
            let gigs = state.installedGB(preset)

            HStack(spacing: 8) {
                ModelStatus(installed: installed,
                            gigabytes: gigs,
                            expected: preset.gigabytes,
                            downloading: state.action == .download)

                Spacer()

                if installed {
                    Text(String(format: "%.1f GB", gigs))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    IconButton(system: "trash", help: state.serverUp
                               ? "Stop the server to delete the model"
                               : "Delete model") {
                        Task { await state.removeModel() }
                    }
                    .disabled(state.busy || state.serverUp)
                }

                PillButton(title: installed ? "Downloaded" : "Download",
                           icon: installed ? "checkmark" : "arrow.down.circle",
                           prominent: !installed,
                           active: state.action == .download) {
                    Task { await state.downloadModel() }
                }
                .disabled(state.busy || installed)
            }

            if let fraction = state.downloadFraction, state.action == .download {
                VStack(alignment: .leading, spacing: 4) {
                    ProgressView(value: fraction)
                        .progressViewStyle(.linear)
                    Text(String(format: "%.1f of %.1f GB", state.downloadedGB, preset.gigabytes))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - voice

    private var voiceCard: some View {
        Card(title: "Voice", icon: "person.wave.2") {
            Picker("", selection: $state.voiceMode) {
                Text("Built-in").tag("bundled")
                Text("My clone").tag("clone")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .onChange(of: state.voiceMode) { _, _ in
                Task { await state.applySettings() }
            }

            if state.voiceMode == "clone" {
                HStack(spacing: 8) {
                    Image(systemName: "waveform.circle")
                        .foregroundStyle(.secondary)
                    Text(state.refAudio == "none"
                         ? "No reference yet"
                         : URL(fileURLWithPath: state.refAudio).lastPathComponent)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    PillButton(title: "Choose audio", icon: "folder", active: state.action == .clone) {
                        state.chooseVoiceFile()
                    }
                    .disabled(state.busy)
                }
            } else {
                Text("Fixed recording that ships with the app, so the voice stays the same.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - options

    private var optionsCard: some View {
        Card(title: "Behaviour", icon: "slider.horizontal.3") {
            Picker("Language", selection: $state.language) {
                Text("Auto").tag("auto")
                Text("Русский").tag("russian")
                Text("English").tag("english")
            }
            .onChange(of: state.language) { _, _ in
                Task { await state.applySettings() }
            }

            Toggle("Start the server with Claude", isOn: $state.autostart)
                .onChange(of: state.autostart) { _, _ in
                    Task { await state.applySettings() }
                }

            Toggle("Say the project name in another session", isOn: $state.announce)
                .onChange(of: state.announce) { _, _ in
                    Task { await state.applySettings() }
                }

            HStack(spacing: 8) {
                Text("Speed")
                Slider(value: $state.speed, in: 0.8...1.4, step: 0.05)
                Text(String(format: "%.2f", state.speed))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 34, alignment: .trailing)
            }
            .onChange(of: state.speed) { _, _ in
                Task { await state.applySettings() }
            }
        }
    }

    // MARK: - plugin

    private var pluginCard: some View {
        Card(title: "Claude plugin", icon: "puzzlepiece.extension") {
            HStack(spacing: 8) {
                ModelStatus(installed: state.pluginInstalled && state.pluginEnabled,
                            gigabytes: 0,
                            expected: 0,
                            downloading: state.action == .install || state.action == .enable,
                            customText: state.pluginInstalled
                                ? (state.pluginEnabled ? "Installed and enabled" : "Installed, disabled")
                                : "Not installed")
                    .foregroundStyle(state.pluginInstalled ? Color.secondary : Color.orange)

                Spacer()

                if state.pluginInstalled {
                    PillButton(title: state.pluginEnabled ? "Disable" : "Enable",
                               icon: state.pluginEnabled ? "pause" : "play",
                               active: state.action == .enable) {
                        Task { await state.setPlugin(enabled: !state.pluginEnabled) }
                    }
                    .disabled(state.busy)
                } else {
                    PillButton(title: "Install", icon: "arrow.down.app", prominent: true,
                               active: state.action == .install) {
                        Task { await state.installPlugin() }
                    }
                    .disabled(state.busy || state.repo == nil)
                }
            }

            HStack(spacing: 6) {
                Image(systemName: "shippingbox")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(state.repoLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
            }
        }
    }

    // MARK: - footer

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let label = state.actionLabel, state.busy {
                HStack(spacing: 7) {
                    ProgressView().controlSize(.small)
                    Text(label).font(.caption)
                }
            }

            if let error = state.errorText {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let notice = state.notice {
                Text(notice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 10) {
                Button("Daemon log") { state.openDaemonLog() }
                    .buttonStyle(.link)
                    .font(.caption2)
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
                    .buttonStyle(.link)
                    .font(.caption2)
            }
        }
        .padding(.horizontal, 4)
    }
}

// MARK: - building blocks

private struct Card<Content: View>: View {
    let title: String
    let icon: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label(title, systemImage: icon)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            content
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

private struct PillButton: View {
    let title: String
    let icon: String
    var prominent = false
    var active = false
    let action: () -> Void

    var body: some View {
        if prominent {
            button.buttonStyle(.glassProminent)
        } else {
            button.buttonStyle(.glass)
        }
    }

    private var button: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if active {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: icon).font(.system(size: 10, weight: .semibold))
                }
                Text(title).font(.system(size: 11, weight: .semibold))
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
        }
        .controlSize(.small)
        .buttonBorderShape(.capsule)
    }
}

private struct IconButton: View {
    let system: String
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: 11, weight: .medium))
                .frame(width: 24, height: 22)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help(help)
    }
}

private struct StatusPill: View {
    let text: String
    let color: Color

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text).font(.system(size: 10, weight: .semibold))
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .glassEffect(.regular, in: Capsule())
        .padding(-1)
    }
}

private struct ModelStatus: View {
    let installed: Bool
    let gigabytes: Double
    let expected: Double
    let downloading: Bool
    var customText: String?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: downloading ? "arrow.down.circle" : (installed ? "checkmark.seal.fill" : "circle.dashed"))
                .font(.system(size: 12))
                .foregroundStyle(downloading ? Color.accentColor : (installed ? Color.green : Color.secondary))
            Text(customText ?? defaultText)
                .font(.caption)
                .foregroundStyle(installed ? Color.secondary : Color.primary)
        }
    }

    private var defaultText: String {
        if downloading { return "Downloading…" }
        if installed { return "Installed" }
        return String(format: "Not downloaded · %.1f GB", expected)
    }
}

private struct VisualEffect: NSViewRepresentable {
    let material: NSVisualEffectView.Material
    let blending: NSVisualEffectView.BlendingMode

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blending
        view.state = .active
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.material = material
        view.blendingMode = blending
    }
}
