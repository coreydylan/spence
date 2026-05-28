//
//  TimerService.swift
//  Spence
//
//  Manages multiple concurrent cooking timers with haptic feedback
//

import SwiftUI
import Combine

@Observable
class TimerService {
    static let shared = TimerService()

    private(set) var activeTimers: [CookingTimer] = []
    private var timerPublisher: AnyCancellable?

    init() {
        startTimerLoop()
    }

    // MARK: - Timer Management

    func startTimer(for stepNumber: Int, duration: TimeInterval, label: String) {
        // Remove existing timer for this step
        activeTimers.removeAll { $0.stepNumber == stepNumber }

        let timer = CookingTimer(
            id: UUID(),
            stepNumber: stepNumber,
            label: label,
            totalDuration: duration,
            remainingTime: duration,
            isRunning: true,
            startedAt: Date()
        )

        activeTimers.append(timer)
        HapticsService.shared.timerStarted()
    }

    func pauseTimer(id: UUID) {
        guard let index = activeTimers.firstIndex(where: { $0.id == id }) else { return }
        activeTimers[index].isRunning = false
        HapticsService.shared.lightTap()
    }

    func resumeTimer(id: UUID) {
        guard let index = activeTimers.firstIndex(where: { $0.id == id }) else { return }
        activeTimers[index].isRunning = true
        activeTimers[index].startedAt = Date()
        HapticsService.shared.lightTap()
    }

    func cancelTimer(id: UUID) {
        activeTimers.removeAll { $0.id == id }
        HapticsService.shared.lightTap()
    }

    func cancelAllTimers() {
        activeTimers.removeAll()
    }

    func addTime(id: UUID, seconds: TimeInterval) {
        guard let index = activeTimers.firstIndex(where: { $0.id == id }) else { return }
        activeTimers[index].remainingTime += seconds
        activeTimers[index].totalDuration += seconds
        HapticsService.shared.lightTap()
    }

    // MARK: - Timer Loop

    private func startTimerLoop() {
        timerPublisher = Timer.publish(every: 1.0, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in
                self?.updateTimers()
            }
    }

    private func updateTimers() {
        for index in activeTimers.indices {
            guard activeTimers[index].isRunning else { continue }

            activeTimers[index].remainingTime -= 1

            // Warning at 30 seconds, 10 seconds, 5 seconds
            let remaining = activeTimers[index].remainingTime
            if remaining == 30 || remaining == 10 || remaining == 5 {
                HapticsService.shared.timerWarning()
            }

            // Timer complete
            if activeTimers[index].remainingTime <= 0 {
                activeTimers[index].remainingTime = 0
                activeTimers[index].isRunning = false
                activeTimers[index].isComplete = true
                HapticsService.shared.timerComplete()
            }
        }
    }

    // MARK: - Helpers

    func timer(for stepNumber: Int) -> CookingTimer? {
        activeTimers.first { $0.stepNumber == stepNumber }
    }

    var hasActiveTimers: Bool {
        activeTimers.contains { $0.isRunning }
    }
}

// MARK: - Cooking Timer Model

struct CookingTimer: Identifiable {
    let id: UUID
    let stepNumber: Int
    let label: String
    var totalDuration: TimeInterval
    var remainingTime: TimeInterval
    var isRunning: Bool
    var startedAt: Date
    var isComplete: Bool = false

    var progress: Double {
        guard totalDuration > 0 else { return 0 }
        return 1.0 - (remainingTime / totalDuration)
    }

    var formattedTime: String {
        let minutes = Int(remainingTime) / 60
        let seconds = Int(remainingTime) % 60
        return String(format: "%02d:%02d", minutes, seconds)
    }

    var isWarning: Bool {
        remainingTime <= 30 && remainingTime > 0
    }
}
