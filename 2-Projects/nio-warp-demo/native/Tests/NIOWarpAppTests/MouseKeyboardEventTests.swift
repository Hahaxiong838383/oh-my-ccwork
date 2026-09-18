import AppKit
import XCTest
@testable import NIOWarpApp

@MainActor final class MouseKeyboardEventTests: XCTestCase {
    func testArrowsWASDAndNavigationUseBrowserKeyCodeAndNativeKeyCode() throws {
        for (native, text, code, key, windows): (UInt16, String, String, String, Int) in [
            (0,"a","KeyA","a",65),(1,"s","KeyS","s",83),(2,"d","KeyD","d",68),(13,"w","KeyW","w",87),
            (123,"\u{f702}","ArrowLeft","ArrowLeft",37),(124,"\u{f703}","ArrowRight","ArrowRight",39),
            (125,"\u{f701}","ArrowDown","ArrowDown",40),(126,"\u{f700}","ArrowUp","ArrowUp",38),
            (116,"\u{f72c}","PageUp","PageUp",33),(117,"\u{f728}","Delete","Delete",46)] {
            let event = Self.key(UUID(), native, text: text)
            XCTAssertTrue(event.isValid)
            XCTAssertEqual(event.parameters["code"] as? String, code)
            XCTAssertEqual(event.parameters["key"] as? String, key)
            XCTAssertEqual(event.parameters["windowsVirtualKeyCode"] as? Int, windows)
            XCTAssertEqual(event.parameters["nativeVirtualKeyCode"] as? Int, Int(native))
            if native >= 115 { XCTAssertEqual(event.parameters["type"] as? String, "rawKeyDown"); XCTAssertNil(event.parameters["text"]) }
        }
    }

    func testTextShiftRepeatAndReleasePreserveLayoutWithoutTypingOnKeyUp() throws {
        let id = UUID()
        let shifted = Self.key(id, 0, text: "A", unmodified: "a", modifiers: 8, repeatKey: true)
        XCTAssertEqual(shifted.parameters["key"] as? String, "A")
        XCTAssertEqual(shifted.parameters["text"] as? String, "A")
        XCTAssertEqual(shifted.parameters["unmodifiedText"] as? String, "a")
        XCTAssertEqual(shifted.parameters["modifiers"] as? Int, 8)
        XCTAssertEqual(shifted.parameters["autoRepeat"] as? Bool, true)
        let released = shifted.released()
        XCTAssertEqual(released.viewportID, id)
        XCTAssertEqual(released.parameters["type"] as? String, "keyUp")
        XCTAssertEqual(released.parameters["modifiers"] as? Int, 0)
        XCTAssertEqual(released.parameters["autoRepeat"] as? Bool, false)
        XCTAssertNil(released.parameters["text"])
        XCTAssertNil(released.parameters["unmodifiedText"])
        let layout = Self.key(id, 0, text: "é", unmodified: "e", modifiers: 1)
        XCTAssertTrue(layout.isValid); XCTAssertEqual(layout.parameters["key"] as? String, "é")
    }

    func testSpaceReturnAndNumericKeypadKeepSemantics() throws {
        let id = UUID(), space = Self.key(id, 49, text: " "), enter = Self.key(id, 36, text: "\r")
        XCTAssertEqual(space.parameters["code"] as? String, "Space")
        XCTAssertEqual(space.parameters["text"] as? String, " ")
        XCTAssertEqual(enter.parameters["key"] as? String, "Enter")
        XCTAssertEqual(enter.parameters["text"] as? String, "\r")
        let num = Self.key(id, 83, text: "1"), numEnter = Self.key(id, 76, text: "\r")
        XCTAssertEqual(num.parameters["code"] as? String, "Numpad1")
        XCTAssertEqual(num.parameters["location"] as? Int, 3)
        XCTAssertEqual(num.parameters["isKeypad"] as? Bool, true)
        XCTAssertEqual(numEnter.parameters["code"] as? String, "NumpadEnter")
        XCTAssertEqual(numEnter.parameters["key"] as? String, "Enter")
    }

    func testSystemShortcutsEscapeAndInvalidValuesNeverBecomeCDPInput() throws {
        for modifiers in [2,4,6,10,12,-1,16] { XCTAssertFalse(Self.key(UUID(), 48, text: "\t", modifiers: modifiers).isValid) }
        for code: UInt16 in [53,54,55,57,59,62,63] { XCTAssertFalse(Self.key(UUID(), code).isValid) }
        XCTAssertFalse(Self.key(UUID(), 0, text: String(repeating: "a", count: 257)).isValid)
        XCTAssertFalse(Self.key(UUID(), 0, down: false, repeatKey: true).isValid)
    }

    func testLeftRightShiftAndAltHaveBalancedIdentityAndLocation() throws {
        for (code, name, physical, location, flag): (UInt16, String, String, Int, Int) in [
            (56,"Shift","ShiftLeft",1,8),(60,"Shift","ShiftRight",2,8),
            (58,"Alt","AltLeft",1,1),(61,"Alt","AltRight",2,1)] {
            let down = Self.key(UUID(), code, text: "", modifiers: flag)
            XCTAssertTrue(down.isValid)
            XCTAssertEqual(down.parameters["key"] as? String, name)
            XCTAssertEqual(down.parameters["code"] as? String, physical)
            XCTAssertEqual(down.parameters["location"] as? Int, location)
            XCTAssertEqual(down.parameters["type"] as? String, "rawKeyDown")
            XCTAssertNil(down.parameters["text"])
            let up = down.released()
            XCTAssertTrue(up.isValid)
            XCTAssertEqual(up.parameters["key"] as? String, name)
            XCTAssertEqual(up.parameters["type"] as? String, "keyUp")
            XCTAssertEqual(up.parameters["modifiers"] as? Int, 0)
        }
    }

    func testOnsiteNumberSequencePreservesMainRowAndKeypadIdentityThroughKeyUp() throws {
        let main: [UInt16] = [19,29,18,19,20,21], keypad: [UInt16] = [84,82,83,84,85,86]
        let digits = ["2","0","1","2","3","4"]
        for (keys, isKeypad) in [(main, false), (keypad, true)] {
            for (index, code) in keys.enumerated() {
                let cg = try XCTUnwrap(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true))
                if isKeypad { cg.flags = .maskNumericPad }
                let native = try XCTUnwrap(NSEvent(cgEvent: cg))
                XCTAssertEqual(native.characters, digits[index])
                let event = Self.key(UUID(), code, text: native.characters ?? "", unmodified: native.charactersIgnoringModifiers ?? "")
                XCTAssertTrue(event.isValid)
                XCTAssertEqual(event.parameters["key"] as? String, digits[index])
                XCTAssertEqual(event.parameters["code"] as? String, (isKeypad ? "Numpad" : "Digit") + digits[index])
                XCTAssertEqual(event.parameters["windowsVirtualKeyCode"] as? Int, (isKeypad ? 96 : 48) + Int(digits[index])!)
                XCTAssertEqual(event.parameters["nativeVirtualKeyCode"] as? Int, Int(code))
                XCTAssertEqual(event.parameters["location"] as? Int, isKeypad ? 3 : 0)
                XCTAssertEqual(event.released().parameters["key"] as? String, digits[index])
                XCTAssertEqual(event.released().parameters["type"] as? String, "keyUp")
                XCTAssertNil(event.released().parameters["text"])
            }
        }
    }

    func testKeysShareMouseOrderingAndRepeatDoesNotCoalesceOrDuplicateOwnership() async throws {
        let fixture = try KeyboardFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        XCTAssertTrue(fixture.transport.send(MouseInputEvent(viewportID: viewport.bindingID, kind: .move, x: 20, y: 30)))
        XCTAssertTrue(fixture.transport.sendKey(Self.key(viewport.bindingID, 13, text: "w")))
        XCTAssertTrue(fixture.transport.sendKey(Self.key(viewport.bindingID, 13, text: "w", repeatKey: true)))
        XCTAssertTrue(fixture.transport.send(MouseInputEvent(viewportID: viewport.bindingID, kind: .move, x: 40, y: 30)))
        XCTAssertTrue(fixture.transport.sendKey(Self.key(viewport.bindingID, 13, down: false, text: "w")))
        try await fixture.transport.flush()
        XCTAssertEqual(fixture.wire.business.map { $0.0 }, ["Input.dispatchMouseEvent","Input.dispatchKeyEvent","Input.dispatchKeyEvent","Input.dispatchMouseEvent","Input.dispatchKeyEvent"])
        XCTAssertEqual(fixture.wire.keys.compactMap { $0["type"] as? String }, ["keyDown","keyDown","keyUp"])
        XCTAssertEqual(fixture.wire.keys.compactMap { $0["autoRepeat"] as? Bool }, [false,true,false])
        await fixture.transport.releaseAllAndClose()
        XCTAssertEqual(fixture.wire.keys.count, 3)
    }

    func testShortcutIsRejectedWithoutClosingOrdinaryInputBinding() async throws {
        let fixture = try KeyboardFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        XCTAssertFalse(fixture.transport.sendKey(Self.key(viewport.bindingID, 48, text: "\t", modifiers: 4)))
        XCTAssertTrue(fixture.transport.isConnected)
        XCTAssertTrue(fixture.wire.keys.isEmpty)
        await fixture.transport.releaseAllAndClose()
    }

    func testRepeatWithoutDownAndDuplicateDownAreRejected() async throws {
        for duplicate in [false, true] {
            let fixture = try KeyboardFixture(); defer { fixture.remove() }
            let viewport = try await fixture.transport.connect(session: fixture.session)
            if duplicate {
                XCTAssertTrue(fixture.transport.sendKey(Self.key(viewport.bindingID, 0)))
                try await fixture.transport.flush()
            }
            XCTAssertFalse(fixture.transport.sendKey(Self.key(viewport.bindingID, 0, repeatKey: !duplicate)))
            await fixture.transport.releaseAllAndClose()
            XCTAssertEqual(fixture.wire.keys.count, duplicate ? 2 : 0)
            XCTAssertFalse(fixture.transport.isConnected)
        }
    }

    func testCloseWaitsForUncertainKeyDownAndReleasesBeforeSocketClose() async throws {
        let fixture = try KeyboardFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        fixture.wire.blockNextKey = true
        XCTAssertTrue(fixture.transport.sendKey(Self.key(viewport.bindingID, 13, text: "w")))
        await fixture.wire.waitForBlockedKey()
        XCTAssertTrue(fixture.transport.sendKey(Self.key(viewport.bindingID, 13, text: "w", repeatKey: true)))
        let closing = Task { await fixture.transport.releaseAllAndClose() }
        for _ in 0..<20 where fixture.transport.isConnected { await Task.yield() }
        fixture.wire.unblockKey()
        await closing.value
        XCTAssertEqual(fixture.wire.keys.compactMap { $0["type"] as? String }, ["keyDown","keyUp"])
        XCTAssertTrue(fixture.wire.closed)
    }

    func testTimedOutKeyDownStillAttemptsReleaseOnSamePage() async throws {
        let fixture = try KeyboardFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        fixture.wire.timeoutNextKey = true
        XCTAssertTrue(fixture.transport.sendKey(Self.key(viewport.bindingID, 49, text: " ")))
        do { try await fixture.transport.flush(); XCTFail("Timed out key must fail barrier") } catch { }
        await fixture.transport.releaseAllAndClose()
        XCTAssertEqual(fixture.wire.keys.compactMap { $0["type"] as? String }, ["keyDown","keyUp"])
    }

    func testAllHeldKeysAndMouseButtonsReleaseOnStop() async throws {
        let fixture = try KeyboardFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        XCTAssertTrue(fixture.transport.sendKey(Self.key(viewport.bindingID, 13, text: "W", modifiers: 8)))
        XCTAssertTrue(fixture.transport.sendKey(Self.key(viewport.bindingID, 123, text: "\u{f702}")))
        XCTAssertTrue(fixture.transport.send(MouseInputEvent(viewportID: viewport.bindingID, kind: .down, x: 20, y: 30, button: .left, buttons: 1)))
        try await fixture.transport.flush()
        await fixture.transport.releaseAllAndClose()
        XCTAssertEqual(fixture.wire.keys.compactMap { $0["type"] as? String }, ["keyDown","rawKeyDown","keyUp","keyUp"])
        XCTAssertTrue(fixture.wire.keys.suffix(2).allSatisfy { $0["modifiers"] as? Int == 0 })
        XCTAssertEqual(fixture.wire.business.filter { $0.0 == "Input.dispatchMouseEvent" }.last?.1["type"] as? String, "mouseReleased")
        XCTAssertTrue(fixture.wire.businessSessions.allSatisfy { $0 == "keyboard-session" })
    }

    func testReloadNeverReleasesOldKeysIntoNewDocument() async throws {
        let fixture = try KeyboardFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        XCTAssertTrue(fixture.transport.sendKey(Self.key(viewport.bindingID, 0)))
        try await fixture.transport.flush()
        fixture.wire.onEvent?("Runtime.executionContextsCleared", [:], "keyboard-session")
        await fixture.transport.releaseAllAndClose()
        XCTAssertEqual(fixture.wire.keys.count, 1)
        XCTAssertFalse(fixture.transport.sendKey(Self.key(viewport.bindingID, 0, down: false)))
    }

    func testSilentPageEpochChangeRejectsQueuedKeyBeforeDispatch() async throws {
        let fixture = try KeyboardFixture(); defer { fixture.remove() }
        let viewport = try await fixture.transport.connect(session: fixture.session)
        fixture.wire.epoch += 1
        XCTAssertTrue(fixture.transport.sendKey(Self.key(viewport.bindingID, 0)))
        do { try await fixture.transport.flush(); XCTFail("Stale key must fail") } catch { }
        await fixture.transport.releaseAllAndClose()
        XCTAssertTrue(fixture.wire.keys.isEmpty)
    }

    func testOldViewportCannotSendKeyToNewBinding() async throws {
        let fixture = try KeyboardFixture(); defer { fixture.remove() }
        let old = try await fixture.transport.connect(session: fixture.session)
        await fixture.transport.releaseAllAndClose()
        _ = try await fixture.transport.connect(session: fixture.session)
        XCTAssertFalse(fixture.transport.sendKey(Self.key(old.bindingID, 0)))
        XCTAssertTrue(fixture.transport.isConnected)
        await fixture.transport.releaseAllAndClose()
    }

    private static func key(_ viewport: UUID, _ code: UInt16, down: Bool = true, text: String = "a",
                            unmodified: String? = nil, modifiers: Int = 0, repeatKey: Bool = false) -> MouseKeyboardEvent {
        MouseKeyboardEvent(viewportID: viewport, input: MouseKeyboardInput(down: down, keyCode: code,
            text: text, unmodifiedText: unmodified ?? text, modifiers: modifiers, isAutoRepeat: repeatKey))
    }
}

@MainActor private final class KeyboardFixture {
    let wire = KeyboardTestWire()
    let profile: URL
    let session: ProtoPieSession
    lazy var transport = MouseInputTransport(profileURL: profile, monitorInterval: 0,
        connectionFactory: { [unowned self] _ in self.wire },
        windowLookup: { _, _ in CGRect(x: 0, y: 0, width: 1920, height: 1080) })
    init() throws {
        profile = FileManager.default.temporaryDirectory.appendingPathComponent("KeyboardTest-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
        try "18765\n/devtools/browser/keyboard-test".write(to: profile.appendingPathComponent("DevToolsActivePort"), atomically: true, encoding: .utf8)
        var configuration = ProtoPieConfiguration(); configuration.cloudURL = "https://cloud.protopie.io/p/keyboard-test"
        session = ProtoPieSession(windowID: 42, processID: 123, configuration: configuration,
            cloudTargetID: "keyboard-target", title: "Keyboard fixture")
        wire.url = try configuration.playbackURL().absoluteString
    }
    func remove() { try? FileManager.default.removeItem(at: profile) }
}

@MainActor private final class KeyboardTestWire: MouseInputCDPConnection {
    var onEvent: ((String, [String: Any], String?) -> Void)?
    var onFailure: ((Error) -> Void)?
    var url = "", epoch = 12345
    var business = [(String, [String: Any])](), businessSessions = [String]()
    var keys: [[String: Any]] { business.filter { $0.0 == "Input.dispatchKeyEvent" }.map(\.1) }
    var blockNextKey = false, timeoutNextKey = false, closed = false
    private var blocked: CheckedContinuation<Void, Never>?
    func call(_ method: String, parameters: [String: Any], sessionID: String?) async throws -> [String: Any] {
        switch method {
        case "SystemInfo.getProcessInfo": closed = false; return ["processInfo": [["type": "browser", "id": 123]]]
        case "Target.getTargetInfo": return ["targetInfo": ["targetId": "keyboard-target", "type": "page", "url": url]]
        case "Target.attachToTarget": return ["sessionId": "keyboard-session"]
        case "Browser.getWindowForTarget": return ["windowId": 88, "bounds": ["left": 0, "top": 0, "width": 1920, "height": 1080, "windowState": "fullscreen"]]
        case "Runtime.evaluate": return ["result": ["value": ["url": url, "width": 1920, "height": 1080, "dpr": 1,
            "timeOrigin": epoch, "ready": true, "visualScale": 1, "visualOffsetX": 0, "visualOffsetY": 0]]]
        case "Input.dispatchMouseEvent", "Input.dispatchKeyEvent":
            business.append((method, parameters)); businessSessions.append(sessionID ?? "")
            if method == "Input.dispatchKeyEvent" {
                if blockNextKey { blockNextKey = false; await withCheckedContinuation { blocked = $0 } }
                if timeoutNextKey { timeoutNextKey = false; throw MouseInputTransportError.timeout }
            }
            return [:]
        default: return [:]
        }
    }
    func waitForBlockedKey() async {
        for _ in 0..<1000 { if blocked != nil { return }; await Task.yield() }
        XCTFail("Keyboard worker did not reach expected dispatch")
    }
    func unblockKey() { blocked?.resume(); blocked = nil }
    func close() { closed = true }
}
