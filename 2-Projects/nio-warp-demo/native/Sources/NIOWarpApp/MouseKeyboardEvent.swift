import Foundation

/// Native capture supplies layout-aware text; only the independent output path
/// wraps this value for the dedicated page. Same-screen keyboard input is native.
struct MouseKeyboardInput: Equatable {
    enum Kind { case down, up }
    let kind: Kind
    let keyCode: UInt16
    let text: String
    let unmodifiedText: String
    let modifiers: Int
    let isAutoRepeat: Bool

    init(kind: Kind, keyCode: UInt16, text: String, unmodifiedText: String, modifiers: Int, isAutoRepeat: Bool) {
        self.kind = kind; self.keyCode = keyCode; self.text = text; self.unmodifiedText = unmodifiedText
        self.modifiers = modifiers; self.isAutoRepeat = isAutoRepeat
    }

    init(down: Bool, keyCode: UInt16, text: String, unmodifiedText: String, modifiers: Int, isAutoRepeat: Bool) {
        self.init(kind: down ? .down : .up, keyCode: keyCode, text: text, unmodifiedText: unmodifiedText,
                  modifiers: modifiers, isAutoRepeat: isAutoRepeat)
    }
}

struct MouseKeyboardEvent: Equatable {
    let viewportID: UUID
    let input: MouseKeyboardInput

    /// A script stores DOM codes so Numpad2 never silently becomes Digit2.
    static func scriptedInput(code: String, down: Bool) -> MouseKeyboardInput? {
        guard let entry = keyMap.first(where: { $0.value.code == code }) else { return nil }
        let key = entry.value
        var text = ""
        if code.hasPrefix("Key"), code.count == 4 { text = String(code.suffix(1)).lowercased() }
        else if code.hasPrefix("Digit") { text = String(code.suffix(1)) }
        else if code.hasPrefix("Numpad"), let digit = Int(code.dropFirst(6)), (0...9).contains(digit) { text = String(digit) }
        else if key.named == nil {
            text = ["Space": " ", "Equal": "=", "Minus": "-", "BracketRight": "]", "BracketLeft": "[",
                "Quote": "'", "Semicolon": ";", "Backslash": "\\", "Comma": ",", "Slash": "/",
                "Period": ".", "Backquote": "`", "NumpadDecimal": ".", "NumpadMultiply": "*",
                "NumpadAdd": "+", "NumpadDivide": "/", "NumpadSubtract": "-", "NumpadEqual": "="][code] ?? ""
        }
        let result = MouseKeyboardInput(down: down, keyCode: entry.key, text: text,
            unmodifiedText: text, modifiers: 0, isAutoRepeat: false)
        return isSupported(result) ? result : nil
    }

    /// Command/Control shortcuts and Escape stay with macOS / the workbench.
    /// Shift/Alt have explicit ownership; Command/Control/Caps/Fn stay native.
    var isValid: Bool { Self.isSupported(input) }

    static func isSupported(_ input: MouseKeyboardInput) -> Bool {
        (0...15).contains(input.modifiers) && input.modifiers & (2 | 4) == 0
            && ![53,54,55,57,59,62,63].contains(input.keyCode)
            && input.text.utf8.count <= 256 && input.unmodifiedText.utf8.count <= 256
            && (input.kind == .down || !input.isAutoRepeat)
            && (Self.keyMap[input.keyCode] != nil || !Self.printable(input.text).isEmpty)
    }

    var parameters: [String: Any] {
        let mapping = Self.keyMap[input.keyCode]
        let text = mapping?.named == "Enter" ? "\r" : mapping?.named == nil ? Self.printable(input.text) : ""
        let unmodified = mapping?.named == "Enter" ? "\r" : mapping?.named == nil ? Self.printable(input.unmodifiedText) : ""
        let key = mapping?.named ?? (text.isEmpty ? (unmodified.isEmpty ? "Unidentified" : unmodified) : text)
        var value: [String: Any] = [
            "type": input.kind == .up ? "keyUp" : text.isEmpty ? "rawKeyDown" : "keyDown",
            "key": key, "code": mapping?.code ?? "Unidentified",
            "windowsVirtualKeyCode": mapping?.windows ?? 0,
            "nativeVirtualKeyCode": Int(input.keyCode), "modifiers": input.modifiers,
            "autoRepeat": input.isAutoRepeat, "isKeypad": mapping?.keypad ?? false,
            "location": mapping?.keypad == true ? 3 : mapping?.location ?? 0
        ]
        if input.kind == .down, !text.isEmpty {
            value["text"] = text; value["unmodifiedText"] = unmodified
        }
        return value
    }

    func released() -> Self {
        Self(viewportID: viewportID, input: MouseKeyboardInput(kind: .up, keyCode: input.keyCode,
            text: input.text, unmodifiedText: input.unmodifiedText, modifiers: 0, isAutoRepeat: false))
    }

    private static func printable(_ text: String) -> String {
        guard text.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value != 0x7f && !(0xf700...0xf8ff).contains($0.value) }) else { return "" }
        return text
    }

    private struct Key {
        let code: String
        let windows: Int
        var named: String? = nil
        var keypad = false
        var location = 0
    }
    private static let keyMap: [UInt16: Key] = {
        var map: [UInt16: Key] = [:]
        let letters: [(UInt16, String)] = [(0,"A"),(1,"S"),(2,"D"),(3,"F"),(4,"H"),(5,"G"),(6,"Z"),(7,"X"),
            (8,"C"),(9,"V"),(11,"B"),(12,"Q"),(13,"W"),(14,"E"),(15,"R"),(16,"Y"),(17,"T"),
            (31,"O"),(32,"U"),(34,"I"),(35,"P"),(37,"L"),(38,"J"),(40,"K"),(45,"N"),(46,"M")]
        for (native, letter) in letters { map[native] = Key(code: "Key" + letter, windows: Int(letter.utf8.first!)) }
        for (native, digit): (UInt16, Int) in [(18,1),(19,2),(20,3),(21,4),(22,6),(23,5),(25,9),(26,7),(28,8),(29,0)] {
            map[native] = Key(code: "Digit\(digit)", windows: 48 + digit)
        }
        for (native, code, windows): (UInt16, String, Int) in [(24,"Equal",187),(27,"Minus",189),(30,"BracketRight",221),
            (33,"BracketLeft",219),(39,"Quote",222),(41,"Semicolon",186),(42,"Backslash",220),(43,"Comma",188),
            (44,"Slash",191),(47,"Period",190),(49,"Space",32),(50,"Backquote",192)] {
            map[native] = Key(code: code, windows: windows)
        }
        for (native, code, windows): (UInt16, String, Int) in [(36,"Enter",13),(48,"Tab",9),(51,"Backspace",8),
            (115,"Home",36),(116,"PageUp",33),(117,"Delete",46),(119,"End",35),(121,"PageDown",34),
            (123,"ArrowLeft",37),(124,"ArrowRight",39),(125,"ArrowDown",40),(126,"ArrowUp",38)] {
            map[native] = Key(code: code, windows: windows, named: code)
        }
        for (native, number): (UInt16, Int) in [(122,1),(120,2),(99,3),(118,4),(96,5),(97,6),(98,7),(100,8),(101,9),
            (109,10),(103,11),(111,12),(105,13),(107,14),(113,15),(106,16),(64,17),(79,18),(80,19),(90,20)] {
            map[native] = Key(code: "F\(number)", windows: 111 + number, named: "F\(number)")
        }
        for (native, digit): (UInt16, Int) in [(82,0),(83,1),(84,2),(85,3),(86,4),(87,5),(88,6),(89,7),(91,8),(92,9)] {
            map[native] = Key(code: "Numpad\(digit)", windows: 96 + digit, keypad: true)
        }
        for (native, code, windows): (UInt16, String, Int) in [(65,"NumpadDecimal",110),(67,"NumpadMultiply",106),
            (69,"NumpadAdd",107),(75,"NumpadDivide",111),(78,"NumpadSubtract",109),(81,"NumpadEqual",187)] {
            map[native] = Key(code: code, windows: windows, keypad: true)
        }
        map[76] = Key(code: "NumpadEnter", windows: 13, named: "Enter", keypad: true)
        map[56] = Key(code: "ShiftLeft", windows: 16, named: "Shift", location: 1)
        map[60] = Key(code: "ShiftRight", windows: 16, named: "Shift", location: 2)
        map[58] = Key(code: "AltLeft", windows: 18, named: "Alt", location: 1)
        map[61] = Key(code: "AltRight", windows: 18, named: "Alt", location: 2)
        return map
    }()
}
