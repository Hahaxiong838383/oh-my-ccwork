import Combine
import Foundation

enum MenuOverlay: Identifiable {
    case subscriptions
    case resetCredit(Account)
    case removeAccount(Account)
    case clearToken
    case xaiAuthorization
    case codexAuthorization

    var id: String {
        switch self {
        case .subscriptions: "subscriptions"
        case let .resetCredit(account): "reset-\(account.id)"
        case let .removeAccount(account): "remove-\(account.id)"
        case .clearToken: "clear-token"
        case .xaiAuthorization: "xai-authorization"
        case .codexAuthorization: "codex-authorization"
        }
    }

    var isAuthorization: Bool {
        switch self {
        case .xaiAuthorization, .codexAuthorization: true
        default: false
        }
    }
}

@MainActor
final class MenuPresentation: ObservableObject {
    @Published private(set) var isVisible = false
    @Published private(set) var overlay: MenuOverlay?
    @Published private(set) var focusRevision = 0
    var hasInFlightAction = false

    func show() {
        isVisible = true
        focusRevision += 1
    }

    func hide() {
        isVisible = false
    }

    func toggle() {
        if isVisible && overlay == nil {
            hide()
        } else {
            show()
        }
    }

    @discardableResult
    func present(_ next: MenuOverlay) -> Bool {
        guard overlay == nil else { return false }
        overlay = next
        focusRevision += 1
        return true
    }

    func beginAuthorization(_ next: MenuOverlay) {
        guard next.isAuthorization,
              overlay == nil || overlay?.id == MenuOverlay.subscriptions.id
        else { return }
        overlay = next
        focusRevision += 1
    }

    func dismissOverlay() {
        overlay = nil
    }

    func handleEscape() {
        if overlay == nil || overlay?.isAuthorization == true {
            hide()
        } else {
            dismissOverlay()
        }
    }

    func handleOutsideInteraction() {
        guard overlay == nil, !hasInFlightAction else { return }
        hide()
    }
}

enum AppRelease {
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.4.2"
    }

    static var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "14"
    }

    static var label: String { "v\(version) (\(build))" }
}
