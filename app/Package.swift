// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "VoiceBriefBar",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(
            name: "VoiceBriefBar",
            path: "Sources/VoiceBriefBar"
        )
    ]
)
