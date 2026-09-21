import AppKit
import Foundation
import Testing
@testable import CPAMenuBar

@Suite @MainActor
struct MenuPresentationTests {
    @Test func ordinaryOutsideClickHidesPanel() {
        let presentation = MenuPresentation()
        presentation.show()
        presentation.handleOutsideInteraction()
        #expect(!presentation.isVisible)
    }

    @Test func confirmationsSurviveOutsideClicks() throws {
        for overlay in [MenuOverlay.clearToken, .subscriptions, .resetCredit(try account()), .removeAccount(try account())] {
            let presentation = MenuPresentation()
            presentation.show()
            presentation.present(overlay)
            presentation.handleOutsideInteraction()
            #expect(presentation.isVisible)
            #expect(presentation.overlay?.id == overlay.id)
        }
    }

    @Test func onlyOneOverlayCanBePresented() {
        let presentation = MenuPresentation()
        #expect(presentation.present(.subscriptions))
        #expect(!presentation.present(.clearToken))
        #expect(presentation.overlay?.id == "subscriptions")
    }

    @Test func escapeCancelsConfirmationWithoutClosingPanel() {
        let presentation = MenuPresentation()
        presentation.show()
        presentation.present(.clearToken)
        presentation.handleEscape()
        #expect(presentation.overlay == nil)
        #expect(presentation.isVisible)
    }

    @Test func escapeWithoutOverlayHidesPanel() {
        let presentation = MenuPresentation()
        presentation.show()
        presentation.handleEscape()
        #expect(!presentation.isVisible)
    }

    @Test func hidingAuthorizationPreservesIt() {
        for overlay in [MenuOverlay.xaiAuthorization, .codexAuthorization] {
            let presentation = MenuPresentation()
            presentation.show()
            presentation.beginAuthorization(overlay)
            presentation.handleEscape()
            #expect(!presentation.isVisible)
            #expect(presentation.overlay?.id == overlay.id)
            let previousRevision = presentation.focusRevision
            presentation.show()
            #expect(presentation.overlay?.id == overlay.id)
            #expect(presentation.focusRevision > previousRevision)
        }
    }

    @Test func statusItemDoesNotDismissConfirmation() {
        let presentation = MenuPresentation()
        presentation.show()
        presentation.present(.clearToken)
        presentation.toggle()
        #expect(presentation.isVisible)
        #expect(presentation.overlay?.id == "clear-token")
    }

    @Test func authorizationReplacesPickerButNotDestructiveConfirmation() {
        let presentation = MenuPresentation()
        presentation.present(.subscriptions)
        presentation.beginAuthorization(.xaiAuthorization)
        #expect(presentation.overlay?.id == "xai-authorization")
        presentation.dismissOverlay()
        presentation.present(.clearToken)
        presentation.beginAuthorization(.codexAuthorization)
        #expect(presentation.overlay?.id == "clear-token")
    }

    @Test func backgroundWorkDoesNotStealFocus() {
        let presentation = MenuPresentation()
        presentation.show()
        let revision = presentation.focusRevision
        presentation.hasInFlightAction = true
        presentation.handleOutsideInteraction()
        #expect(presentation.isVisible)
        #expect(presentation.focusRevision == revision)
        presentation.hasInFlightAction = false
        presentation.handleOutsideInteraction()
        #expect(!presentation.isVisible)
    }

    @Test func explicitHidePreservesPendingConfirmation() {
        let presentation = MenuPresentation()
        presentation.show()
        presentation.present(.clearToken)
        presentation.hide()
        presentation.show()
        #expect(presentation.overlay?.id == "clear-token")
    }

    @Test func panelIsActivatableAndRemainsOwnedWhenClosed() {
        _ = NSApplication.shared
        let panel = MenuBarPanel()
        #expect(panel.canBecomeKey)
        #expect(!panel.canBecomeMain)
        #expect(!panel.styleMask.contains(.nonactivatingPanel))
        #expect(!panel.isReleasedWhenClosed)
        #expect(!panel.hidesOnDeactivate)
        #expect(!panel.isVisible)
        panel.close()
    }

    @Test func placementClampsToVisibleScreenAndPreservesSize() {
        let visibleFrame = NSRect(x: -1440, y: 32, width: 1440, height: 868)
        let anchor = NSRect(x: -1432, y: 900, width: 65, height: 24)
        let frame = PanelPlacement.frame(anchor: anchor, visibleFrame: visibleFrame)
        #expect(frame.width == 400)
        #expect(frame.height == 560)
        #expect(visibleFrame.contains(frame))
    }

    @Test func placementFitsSmallScreens() {
        let visibleFrame = NSRect(x: 0, y: 0, width: 350, height: 500)
        let anchor = NSRect(x: 315, y: 500, width: 35, height: 24)
        let frame = PanelPlacement.frame(anchor: anchor, visibleFrame: visibleFrame)
        #expect(visibleFrame.contains(frame))
        #expect(frame.width <= 334)
        #expect(frame.height <= 484)
    }

    private func account() throws -> Account {
        try JSONDecoder().decode(Account.self, from: Data(
            #"{"id":"fixture","provider":"codex","email_masked":"f***@example.com","disabled":false,"has_refresh_token":true,"is_k12":false,"usage_status":"ok","removal_eligible":true}"#.utf8
        ))
    }
}
