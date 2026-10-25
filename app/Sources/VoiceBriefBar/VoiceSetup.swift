import Foundation

enum VoiceSetupError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        }
    }
}

enum VoiceSetup {
    private static let filters = [
        "highpass=f=80",
        "lowpass=f=8000",
        "afftdn=nf=-25",
        "silenceremove=start_periods=1:start_threshold=-45dB:" +
        "stop_periods=-1:stop_threshold=-45dB:stop_duration=0.3",
        "loudnorm=I=-18:TP=-2",
    ].joined(separator: ",")

    /// Cuts a clean 3-10s reference, transcribes it and writes ref.wav/ref.txt.
    static func buildReference(
        from input: URL,
        name: String,
        log: @escaping @Sendable (String) -> Void
    ) async throws -> (wav: URL, text: String) {
        let safeName = name
            .replacingOccurrences(of: "[^A-Za-z0-9_-]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let folder = Paths.appSupport
            .appendingPathComponent("refs")
            .appendingPathComponent(safeName.isEmpty ? "default" : safeName)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let target = folder.appendingPathComponent("ref.wav")

        log("Cleaning audio")
        let clean = await Shell.run([
            "/usr/bin/env", "ffmpeg", "-y", "-v", "error",
            "-t", "10", "-i", input.path,
            "-af", filters,
            "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le",
            target.path,
        ])
        guard clean.ok else {
            throw VoiceSetupError.message(
                "ffmpeg failed. Install it with: brew install ffmpeg\n\(clean.message)")
        }

        log("Transcribing")
        let text = try await transcribe(target)
        guard !text.isEmpty else {
            throw VoiceSetupError.message(
                "No transcript: the server is not running or has no whisper model. " +
                "Start the server and try again.")
        }
        try text.write(to: folder.appendingPathComponent("ref.txt"), atomically: true, encoding: .utf8)
        return (target, text)
    }

    static func transcribe(_ wav: URL) async throws -> String {
        let data = try Data(contentsOf: wav)
        for model in ["mlx-community/whisper-large-v3-turbo-asr-fp16",
                      "mlx-community/whisper-small-mlx"] {
            if let text = try? await post(wavData: data, model: model), !text.isEmpty {
                return text
            }
        }
        return ""
    }

    private static func post(wavData: Data, model: String) async throws -> String {
        guard let url = URL(string: "http://127.0.0.1:\(Server.port)/v1/audio/transcriptions") else {
            throw VoiceSetupError.message("bad transcription URL")
        }
        let boundary = "----voicebrief\(UUID().uuidString)"
        var body = Data()

        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }

        field("model", model)
        field("language", "ru")
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"ref.wav\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
        body.append(wavData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = 300

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw VoiceSetupError.message("transcription HTTP error")
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = object["text"] as? String else {
            return ""
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
