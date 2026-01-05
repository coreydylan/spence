//
//  TimerView.swift
//  Spence
//
//  Glass timer display with progress ring and haptic feedback
//

import SwiftUI

struct TimerView: View {
    @ObservedObject var timer: CookTimer

    var body: some View {
        HStack(spacing: 20) {
            // Circular progress ring
            ZStack {
                // Background ring
                Circle()
                    .stroke(
                        Color.white.opacity(0.2),
                        lineWidth: 6
                    )
                    .frame(width: 80, height: 80)

                // Progress ring
                Circle()
                    .trim(from: 0, to: timer.progress)
                    .stroke(
                        timer.color,
                        style: StrokeStyle(
                            lineWidth: 6,
                            lineCap: .round
                        )
                    )
                    .frame(width: 80, height: 80)
                    .rotationEffect(.degrees(-90))
                    .animation(.linear(duration: 0.5), value: timer.progress)

                // Center icon
                Image(systemName: timer.isComplete ? "checkmark" : "timer")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(timer.color)
            }

            // Time display
            VStack(alignment: .leading, spacing: 4) {
                Text(timer.displayTime)
                    .font(.cookModeTimer)
                    .foregroundStyle(.white)
                    .monospacedDigit()

                Text(timer.statusText)
                    .font(.system(size: 14, weight: .medium, design: .rounded))
                    .foregroundStyle(timer.color)
            }

            Spacer()

            // Play/Pause button
            Button(action: {
                timer.togglePause()
            }) {
                Image(systemName: timer.isPaused ? "play.fill" : "pause.fill")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 50, height: 50)
                    .background(
                        Circle()
                            .fill(.white.opacity(0.2))
                    )
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 20)
        .background(
            RoundedRectangle(cornerRadius: 24)
                .fill(.ultraThinMaterial)
                .shadow(color: timer.color.opacity(0.3), radius: 15, y: 5)
        )
        .padding(.horizontal, 24)
    }
}

// MARK: - Timer Model

class CookTimer: ObservableObject {
    let totalDuration: TimeInterval
    @Published var timeRemaining: TimeInterval
    @Published var isRunning: Bool = false
    @Published var isPaused: Bool = false
    @Published var isComplete: Bool = false

    private var timer: Timer?
    private var lastUpdateTime: Date?
    private var hasTriggeredLowTimeHaptic = false
    private var hasTriggeredCompleteHaptic = false

    init(durationMinutes: Double) {
        self.totalDuration = durationMinutes * 60
        self.timeRemaining = totalDuration
    }

    var progress: Double {
        guard totalDuration > 0 else { return 0 }
        return max(0, min(1, (totalDuration - timeRemaining) / totalDuration))
    }

    var displayTime: String {
        let minutes = Int(timeRemaining) / 60
        let seconds = Int(timeRemaining) % 60
        return String(format: "%02d:%02d", minutes, seconds)
    }

    var statusText: String {
        if isComplete {
            return "Time's up!"
        } else if isPaused {
            return "Paused"
        } else if isLowTime {
            return "Almost done"
        } else {
            return "Remaining"
        }
    }

    var color: Color {
        if isComplete {
            return .timerComplete
        } else if isLowTime {
            return .timerWarning
        } else {
            return .timerActive
        }
    }

    private var isLowTime: Bool {
        timeRemaining <= 30 && timeRemaining > 0
    }

    func start() {
        guard !isRunning else { return }

        isRunning = true
        isPaused = false
        lastUpdateTime = Date()

        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.update()
        }
    }

    func stop() {
        isRunning = false
        timer?.invalidate()
        timer = nil
    }

    func togglePause() {
        if isPaused {
            // Resume
            isPaused = false
            lastUpdateTime = Date()

            // Light haptic
            let impact = UIImpactFeedbackGenerator(style: .light)
            impact.impactOccurred()
        } else {
            // Pause
            isPaused = true

            // Light haptic
            let impact = UIImpactFeedbackGenerator(style: .light)
            impact.impactOccurred()
        }
    }

    private func update() {
        guard !isPaused, let lastUpdate = lastUpdateTime else { return }

        let now = Date()
        let elapsed = now.timeIntervalSince(lastUpdate)
        lastUpdateTime = now

        timeRemaining = max(0, timeRemaining - elapsed)

        // Check for completion
        if timeRemaining <= 0 && !isComplete {
            isComplete = true
            stop()
            triggerCompleteHaptic()
        }

        // Check for low time warning
        if isLowTime && !hasTriggeredLowTimeHaptic {
            triggerLowTimeHaptic()
        }
    }

    private func triggerLowTimeHaptic() {
        hasTriggeredLowTimeHaptic = true

        // Medium impact
        let impact = UIImpactFeedbackGenerator(style: .medium)
        impact.impactOccurred()
    }

    private func triggerCompleteHaptic() {
        hasTriggeredCompleteHaptic = true

        // Success notification
        let notification = UINotificationFeedbackGenerator()
        notification.notificationOccurred(.success)

        // Additional impacts for emphasis
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            let impact = UIImpactFeedbackGenerator(style: .heavy)
            impact.impactOccurred()
        }
    }
}

// MARK: - Preview

#Preview("Timer - Active") {
    ZStack {
        Color.black.ignoresSafeArea()

        TimerView(timer: {
            let timer = CookTimer(durationMinutes: 5)
            timer.timeRemaining = 180 // 3 minutes remaining
            timer.isRunning = true
            return timer
        }())
    }
}

#Preview("Timer - Low Time") {
    ZStack {
        Color.black.ignoresSafeArea()

        TimerView(timer: {
            let timer = CookTimer(durationMinutes: 5)
            timer.timeRemaining = 25 // 25 seconds remaining
            timer.isRunning = true
            return timer
        }())
    }
}

#Preview("Timer - Complete") {
    ZStack {
        Color.black.ignoresSafeArea()

        TimerView(timer: {
            let timer = CookTimer(durationMinutes: 5)
            timer.timeRemaining = 0
            timer.isComplete = true
            return timer
        }())
    }
}

#Preview("Timer - Paused") {
    ZStack {
        Color.black.ignoresSafeArea()

        TimerView(timer: {
            let timer = CookTimer(durationMinutes: 5)
            timer.timeRemaining = 240 // 4 minutes remaining
            timer.isRunning = true
            timer.isPaused = true
            return timer
        }())
    }
}
