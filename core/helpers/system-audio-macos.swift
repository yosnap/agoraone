// Records what the Mac plays (Meet, Zoom, Teams…) to an AAC file with ScreenCaptureKit, for AgoraOne's
// meetings. It never records the screen: the stream asks for audio, and the tiny video it must carry is dropped.
// Usage: agora-system-audio <salida.m4a>
// Prints "ready" when it is recording; stops and closes the file on SIGTERM, SIGINT or when its input closes
// (the core that started it is gone). Exit codes: 0 done, 2 no permission, 3 any other failure.
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

setvbuf(stdout, nil, _IOLBF, 0)

func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write("error:\(message)\n".data(using: .utf8)!)
    exit(code)
}

guard CommandLine.arguments.count == 2 else { fail(3, "uso: agora-system-audio <salida.m4a>") }
let output = URL(fileURLWithPath: CommandLine.arguments[1])
if FileManager.default.fileExists(atPath: output.path) { fail(3, "el archivo de salida ya existe") }

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    let queue = DispatchQueue(label: "agora.system-audio")
    var started = false
    var stream: SCStream?
    var finishing = false

    init(url: URL) throws {
        writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
        input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 96_000,
        ])
        input.expectsMediaDataInRealTime = true
        writer.add(input)
        super.init()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, buffer.isValid, !finishing else { return }
        if !started {
            guard writer.startWriting() else { fail(3, "no se pudo escribir el archivo") }
            writer.startSession(atSourceTime: buffer.presentationTimeStamp)
            started = true
        }
        if input.isReadyForMoreMediaData { input.append(buffer) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        finish(code: 3, message: "la captura se detuvo: \(error.localizedDescription)")
    }

    func finish(code: Int32 = 0, message: String? = nil) {
        queue.async {
            if self.finishing { return }
            self.finishing = true
            let done = DispatchGroup()
            if let stream = self.stream { done.enter(); stream.stopCapture { _ in done.leave() } }
            done.wait()
            if let message { FileHandle.standardError.write("error:\(message)\n".data(using: .utf8)!) }
            guard self.started else { try? FileManager.default.removeItem(at: output); exit(code) }
            self.input.markAsFinished()
            self.writer.finishWriting { exit(self.writer.status == .completed ? code : 3) }
        }
    }
}

let recorder: Recorder
do { recorder = try Recorder(url: output) } catch { fail(3, "no se pudo crear el archivo") }

for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { recorder.finish() }
    source.resume()
    objc_setAssociatedObject(recorder, "signal-\(sig)", source, .OBJC_ASSOCIATION_RETAIN)
}
// The core keeps this pipe open while it lives; when it closes, nobody can stop us, so we stop.
Thread.detachNewThread {
    while FileHandle.standardInput.availableData.count > 0 {}
    recorder.finish()
}

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else { fail(3, "no hay pantalla") }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 10, timescale: 1)
        config.queueDepth = 3
        let stream = SCStream(filter: filter, configuration: config, delegate: recorder)
        try stream.addStreamOutput(recorder, type: .audio, sampleHandlerQueue: recorder.queue)
        try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: DispatchQueue(label: "agora.drop-video"))
        recorder.stream = stream
        try await stream.startCapture()
        print("ready")
    } catch {
        let denied = (error as NSError).domain == SCStreamErrorDomain && (error as NSError).code == SCStreamError.userDeclined.rawValue
        fail(denied ? 2 : 3, denied ? "permiso" : error.localizedDescription)
    }
}

dispatchMain()
