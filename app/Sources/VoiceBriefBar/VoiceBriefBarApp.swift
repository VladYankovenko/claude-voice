import AppKit
import SwiftUI

@main
struct VoiceBriefBarApp: App {
    @StateObject private var state = AppState()

    init() {
        if let index = CommandLine.arguments.firstIndex(of: "--snapshot"),
           index + 1 < CommandLine.arguments.count {
            Self.runSnapshot(path: CommandLine.arguments[index + 1])
        }
        if CommandLine.arguments.contains("--preview") {
            Self.runPreview()
        }
        Self.runHeadlessIfAsked()
    }

    /// Renders the panel into a PNG without touching the screen, so screenshots
    /// do not need the Screen Recording permission.
    private static func runSnapshot(path: String) {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)

        let hosting = NSHostingView(rootView: PanelView().environmentObject(AppState()))
        hosting.frame = NSRect(x: 0, y: 0, width: 420, height: 900)

        let window = NSWindow(
            contentRect: hosting.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = hosting
        window.orderBack(nil)

        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            hosting.layoutSubtreeIfNeeded()
            guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
                FileHandle.standardError.write("snapshot: no bitmap\n".data(using: .utf8)!)
                exit(1)
            }
            hosting.cacheDisplay(in: hosting.bounds, to: rep)
            guard let data = rep.representation(using: .png, properties: [:]) else {
                FileHandle.standardError.write("snapshot: no png\n".data(using: .utf8)!)
                exit(1)
            }
            try? data.write(to: URL(fileURLWithPath: path))
            print("snapshot written: \(path)")
            exit(0)
        }
        app.run()
    }

    /// A plain window with the same panel, used to take screenshots. Runs its
    /// own event loop and never returns to SwiftUI.
    private static func runPreview() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        if CommandLine.arguments.contains("--light") {
            app.appearance = NSAppearance(named: .aqua)
        }

        let root = PanelView().environmentObject(AppState())
        let hosting = NSHostingView(rootView: root)
        hosting.frame = NSRect(x: 0, y: 0, width: 420, height: 900)

        let window = NSWindow(
            contentRect: NSRect(x: 120, y: 120, width: 388, height: 720),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isMovableByWindowBackground = true
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)

        window.setContentSize(NSSize(width: 388, height: 760))
        window.setFrameOrigin(NSPoint(x: 60, y: 120))
        app.activate(ignoringOtherApps: true)

        let frame = window.frame
        let screen = NSScreen.main?.frame ?? .zero
        FileHandle.standardError.write(
            "PREVIEW frame=\(frame.origin.x),\(frame.origin.y),\(frame.width),\(frame.height) screen=\(screen.width),\(screen.height)\n"
                .data(using: .utf8)!)
        app.run()
    }

    private static func runHeadlessIfAsked() {
        let args = CommandLine.arguments
        guard args.contains("--selftest") || args.contains("--prepare") || args.contains("--start-server") || args.contains("--models") else { return }

        print("bundled python: \(Runtime.bundledPython?.path ?? "none")")
        print("venv python:    \(Paths.venvPython.path)")
        print("venv ready:     \(Runtime.venvReady)")

        if args.contains("--models") {
            for preset in Presets.all {
                let url = Paths.modelCache(preset.model)
                let bytes = Paths.directorySize(url)
                print(preset.id, "path:", url.path, "exists:", FileManager.default.fileExists(atPath: url.path), "bytes:", bytes, "GB:", Double(bytes)/1_000_000_000)
            }
            exit(0)
        }

        guard args.contains("--prepare") || args.contains("--start-server") else { exit(0) }

        let wantsServer = args.contains("--start-server")
        let group = DispatchGroup()
        group.enter()
        Task.detached {
            let error = await Runtime.ensureVenv { print($0) }
            print(error ?? "environment ready")
            if error == nil, wantsServer {
                if let startError = await Server.start() {
                    print("server error: \(startError)")
                } else {
                    print("server started")
                }
            }
            group.leave()
        }
        while group.wait(timeout: .now() + 0.05) == .timedOut {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        exit(0)
    }

    var body: some Scene {
        MenuBarExtra {
            PanelView()
                .environmentObject(state)
        } label: {
            Image(systemName: state.serverUp ? "waveform.circle.fill" : "waveform.circle")
                .symbolRenderingMode(.hierarchical)
        }
        .menuBarExtraStyle(.window)
    }
}
