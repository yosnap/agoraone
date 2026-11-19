// «Oye Watson» for AgoraOne (1.5): listens to the microphone with Apple's speech recognition ON THIS MAC
// (on-device only: it refuses to run otherwise) and prints "wake" when it hears the phrase. Nothing heard is
// kept, printed or sent; the desktop app reads the "wake" lines and makes Watson listen.
// Usage: agora-wake [frase…]  (default: «oye watson»). Prints "ready" when listening. Exit codes, which the
// desktop app shows in Ajustes › Voz: 2 no speech-recognition permission, 3 the microphone did not open,
// 4 this Mac cannot recognise Spanish without internet, 5 no microphone permission. Stops on SIGTERM or when
// its input closes.
import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)
func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write("error:\(message)\n".data(using: .utf8)!)
    exit(code)
}

func plain(_ text: String) -> String {
    text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "es_ES"))
        .components(separatedBy: CharacterSet.letters.inverted).filter { !$0.isEmpty }.joined(separator: " ")
}
let phrase = plain(CommandLine.arguments.count > 1 ? CommandLine.arguments.dropFirst().joined(separator: " ") : "oye watson")
// What recognition often makes of a name it does not know.
let names = ["watson", "guatson", "wasson", "watsson", "vatson", "whatson", "wattson"]
func heard(_ text: String) -> Bool {
    let said = plain(text)
    if said.contains(phrase) { return true }
    return said.contains("oye") && names.contains { said.contains("oye \($0)") }
}

final class Listener {
    let recognizer: SFSpeechRecognizer
    let engine = AVAudioEngine()
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var restart: Timer?
    var quietUntil = Date.distantPast
    // Each session has a number; the end of an older one (cancelled because a new one started) is ignored, or
    // every restart would trigger another and sessions would last half a second, too short to hear the phrase.
    var current = 0
    var lastStart = Date.distantPast

    init() {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "es-ES")), recognizer.supportsOnDeviceRecognition else {
            fail(4, "sin reconocimiento en el equipo")
        }
        self.recognizer = recognizer
    }

    func begin() {
        let input = engine.inputNode
        // No microphone at all: say so instead of failing inside the audio engine.
        if input.outputFormat(forBus: 0).channelCount == 0 { fail(3, "sin micrófono") }
        input.installTap(onBus: 0, bufferSize: 2048, format: input.outputFormat(forBus: 0)) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        engine.prepare()
        do { try engine.start() } catch { fail(3, "no se pudo abrir el micrófono") }
        session()
        print("ready")
    }

    // Apple's recognition caps a session at about a minute: a fresh one every 50 s.
    func session() {
        current += 1
        let number = current
        lastStart = Date()
        task?.cancel()
        request?.endAudio()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        self.request = request
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, number == self.current else { return }
                if let text = result?.bestTranscription.formattedString, heard(text), Date() > self.quietUntil {
                    self.quietUntil = Date().addingTimeInterval(4)
                    print("wake")
                    self.session()  // forget what was heard
                } else if error != nil || result?.isFinal == true {
                    // A session that fails at once (e.g. silence) waits longer before the next one, so a
                    // failing recogniser is not hammered: macOS runs out of resources for dictation otherwise.
                    let wait = Date().timeIntervalSince(self.lastStart) < 2 ? 3.0 : 0.5
                    DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
                        if number == self.current { self.session() }
                    }
                }
            }
        }
        restart?.invalidate()
        restart = Timer.scheduledTimer(withTimeInterval: 50, repeats: false) { [weak self] _ in self?.session() }
    }
}

var keep: Listener?
for sig in [SIGTERM, SIGINT] { signal(sig, SIG_DFL) }
Thread.detachNewThread {
    while FileHandle.standardInput.availableData.count > 0 {}
    exit(0)
}

SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else { fail(2, "permiso") }
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        guard granted else { fail(5, "micrófono") }
        DispatchQueue.main.async {
            keep = Listener()
            keep?.begin()
        }
    }
}
RunLoop.main.run()
