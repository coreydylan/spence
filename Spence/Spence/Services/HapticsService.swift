//
//  HapticsService.swift
//  Spence
//
//  Centralized haptic feedback for the app
//

import UIKit
import SwiftUI

class HapticsService {
    static let shared = HapticsService()

    private let lightGenerator = UIImpactFeedbackGenerator(style: .light)
    private let mediumGenerator = UIImpactFeedbackGenerator(style: .medium)
    private let heavyGenerator = UIImpactFeedbackGenerator(style: .heavy)
    private let selectionGenerator = UISelectionFeedbackGenerator()
    private let notificationGenerator = UINotificationFeedbackGenerator()

    private init() {
        // Prepare generators
        prepareAll()
    }

    private func prepareAll() {
        lightGenerator.prepare()
        mediumGenerator.prepare()
        heavyGenerator.prepare()
        selectionGenerator.prepare()
        notificationGenerator.prepare()
    }

    // MARK: - Basic Feedback

    func lightTap() {
        lightGenerator.impactOccurred()
        lightGenerator.prepare()
    }

    func mediumTap() {
        mediumGenerator.impactOccurred()
        mediumGenerator.prepare()
    }

    func heavyTap() {
        heavyGenerator.impactOccurred()
        heavyGenerator.prepare()
    }

    func selection() {
        selectionGenerator.selectionChanged()
        selectionGenerator.prepare()
    }

    // MARK: - Notification Feedback

    func success() {
        notificationGenerator.notificationOccurred(.success)
        notificationGenerator.prepare()
    }

    func warning() {
        notificationGenerator.notificationOccurred(.warning)
        notificationGenerator.prepare()
    }

    func error() {
        notificationGenerator.notificationOccurred(.error)
        notificationGenerator.prepare()
    }

    // MARK: - Cook Mode Specific

    /// Step navigation in cook mode
    func stepChanged() {
        mediumGenerator.impactOccurred(intensity: 0.7)
        mediumGenerator.prepare()
    }

    /// Timer started
    func timerStarted() {
        lightGenerator.impactOccurred(intensity: 0.5)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.lightGenerator.impactOccurred(intensity: 0.8)
        }
        lightGenerator.prepare()
    }

    /// Timer warning (running low)
    func timerWarning() {
        notificationGenerator.notificationOccurred(.warning)
        notificationGenerator.prepare()
    }

    /// Timer complete
    func timerComplete() {
        // Pattern: heavy-pause-heavy-pause-heavy
        heavyGenerator.impactOccurred()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            self?.heavyGenerator.impactOccurred()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.heavyGenerator.impactOccurred()
        }
        heavyGenerator.prepare()
    }

    /// Phase completed (all prep done, etc.)
    func phaseComplete() {
        notificationGenerator.notificationOccurred(.success)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.lightGenerator.impactOccurred(intensity: 0.6)
        }
        notificationGenerator.prepare()
    }

    /// Item checked off
    func itemChecked() {
        lightGenerator.impactOccurred(intensity: 0.5)
        lightGenerator.prepare()
    }

    /// Button pressed (glass button press feedback)
    func buttonPressed() {
        lightGenerator.impactOccurred(intensity: 0.4)
        lightGenerator.prepare()
    }

    /// Swipe gesture in cook mode
    func swipe() {
        lightGenerator.impactOccurred(intensity: 0.6)
        lightGenerator.prepare()
    }
}

// MARK: - SwiftUI View Extension

extension View {
    func hapticOnTap(_ style: HapticStyle = .light) -> some View {
        self.simultaneousGesture(
            TapGesture().onEnded { _ in
                switch style {
                case .light:
                    HapticsService.shared.lightTap()
                case .medium:
                    HapticsService.shared.mediumTap()
                case .heavy:
                    HapticsService.shared.heavyTap()
                case .selection:
                    HapticsService.shared.selection()
                case .success:
                    HapticsService.shared.success()
                }
            }
        )
    }
}

enum HapticStyle {
    case light
    case medium
    case heavy
    case selection
    case success
}
