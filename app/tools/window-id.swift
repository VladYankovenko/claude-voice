import CoreGraphics

// Prints one line per on-screen window owned by Claude Voice:
//   <window id> <layer> <owner> <bounds>
// Used by tools/screenshots.sh to find the preview window without guessing.
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for window in windows {
    let owner = window[kCGWindowOwnerName as String] as? String ?? "?"
    guard owner == "Claude Voice" || owner.contains("VoiceBrief") else { continue }
    let number = window[kCGWindowNumber as String] as? Int ?? -1
    let layer = window[kCGWindowLayer as String] as? Int ?? -1
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    print(number, layer, owner, bounds)
}
