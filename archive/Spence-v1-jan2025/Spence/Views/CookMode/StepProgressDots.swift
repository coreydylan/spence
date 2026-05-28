//
//  StepProgressDots.swift
//  Spence
//
//  Visual progress indicator for cook mode steps
//

import SwiftUI

struct StepProgressDots: View {
    let currentStep: Int
    let totalSteps: Int
    let onStepTap: (Int) -> Void

    private let dotSize: CGFloat = 10
    private let dotSpacing: CGFloat = 12
    private let activeDotSize: CGFloat = 14

    var body: some View {
        HStack(spacing: dotSpacing) {
            ForEach(0..<totalSteps, id: \.self) { index in
                DotView(
                    index: index,
                    currentStep: currentStep,
                    size: index == currentStep ? activeDotSize : dotSize
                )
                .onTapGesture {
                    onStepTap(index)
                }
            }
        }
        .padding(.horizontal, 20)
    }
}

// MARK: - Dot View

struct DotView: View {
    let index: Int
    let currentStep: Int
    let size: CGFloat

    private var isCompleted: Bool {
        index < currentStep
    }

    private var isCurrent: Bool {
        index == currentStep
    }

    private var isFuture: Bool {
        index > currentStep
    }

    var body: some View {
        ZStack {
            // Background circle
            Circle()
                .fill(fillColor)
                .frame(width: size, height: size)

            // Border for future steps
            if isFuture {
                Circle()
                    .stroke(Color.white.opacity(0.3), lineWidth: 1.5)
                    .frame(width: size, height: size)
            }

            // Pulse effect for current step
            if isCurrent {
                Circle()
                    .stroke(Color.spenceOrange.opacity(0.3), lineWidth: 2)
                    .frame(width: size + 8, height: size + 8)
                    .scaleEffect(pulseScale)
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: isCurrent)
        .animation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true), value: pulseScale)
        .onAppear {
            if isCurrent {
                pulseScale = 1.2
            }
        }
        .onChange(of: isCurrent) { _, newValue in
            pulseScale = newValue ? 1.2 : 1.0
        }
    }

    private var fillColor: Color {
        if isCurrent {
            return .spenceOrange
        } else if isCompleted {
            return .white.opacity(0.8)
        } else {
            return .clear
        }
    }

    @State private var pulseScale: CGFloat = 1.0
}

// MARK: - Preview

#Preview("Progress Dots - Beginning") {
    ZStack {
        Color.black.ignoresSafeArea()

        VStack(spacing: 40) {
            StepProgressDots(
                currentStep: 0,
                totalSteps: 8,
                onStepTap: { _ in }
            )

            Text("Step 1 of 8")
                .foregroundStyle(.white)
        }
    }
}

#Preview("Progress Dots - Middle") {
    ZStack {
        Color.black.ignoresSafeArea()

        VStack(spacing: 40) {
            StepProgressDots(
                currentStep: 3,
                totalSteps: 8,
                onStepTap: { _ in }
            )

            Text("Step 4 of 8")
                .foregroundStyle(.white)
        }
    }
}

#Preview("Progress Dots - End") {
    ZStack {
        Color.black.ignoresSafeArea()

        VStack(spacing: 40) {
            StepProgressDots(
                currentStep: 7,
                totalSteps: 8,
                onStepTap: { _ in }
            )

            Text("Step 8 of 8")
                .foregroundStyle(.white)
        }
    }
}

#Preview("Progress Dots - Few Steps") {
    ZStack {
        Color.black.ignoresSafeArea()

        VStack(spacing: 40) {
            StepProgressDots(
                currentStep: 1,
                totalSteps: 3,
                onStepTap: { _ in }
            )

            Text("Step 2 of 3")
                .foregroundStyle(.white)
        }
    }
}

#Preview("Progress Dots - Many Steps") {
    ZStack {
        Color.black.ignoresSafeArea()

        ScrollView(.horizontal, showsIndicators: false) {
            StepProgressDots(
                currentStep: 5,
                totalSteps: 15,
                onStepTap: { _ in }
            )
        }

        VStack {
            Spacer()
            Text("Step 6 of 15")
                .foregroundStyle(.white)
        }
    }
}
