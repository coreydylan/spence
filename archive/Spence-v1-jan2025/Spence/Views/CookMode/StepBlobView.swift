//
//  StepBlobView.swift
//  Spence
//
//  THE BLOB - The main step card that guides you through cooking
//

import SwiftUI

struct StepBlobView: View {
    let step: CookStep
    let stepNumber: Int
    let totalSteps: Int

    @State private var isFloating = false

    var body: some View {
        VStack(spacing: 0) {
            // Step number badge
            HStack {
                Text("STEP \(stepNumber)")
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                    .background(
                        Capsule()
                            .fill(Color.spenceOrange)
                    )

                Spacer()

                // Time estimate badge
                if let timeMinutes = step.timeMinutes {
                    HStack(spacing: 4) {
                        Image(systemName: "timer")
                        Text("\(timeMinutes) min")
                    }
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.8))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(
                        Capsule()
                            .fill(.white.opacity(0.2))
                    )
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 24)

            // Main instruction text
            ScrollView {
                Text(step.instruction)
                    .font(.cookModeBody)
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .lineSpacing(8)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 32)
            }
            .frame(maxHeight: 300)

            // Sensory cues section
            if step.hasSensoryCues {
                VStack(spacing: 16) {
                    Divider()
                        .background(.white.opacity(0.2))
                        .padding(.horizontal, 24)

                    VStack(spacing: 12) {
                        if let visual = step.cueVisual {
                            SensoryCueRow(icon: "eye.fill", label: "Look for", cue: visual)
                        }

                        if let audio = step.cueAudio {
                            SensoryCueRow(icon: "ear.fill", label: "Listen for", cue: audio)
                        }

                        if let aroma = step.cueAroma {
                            SensoryCueRow(icon: "nose.fill", label: "Smell for", cue: aroma)
                        }
                    }
                    .padding(.horizontal, 24)
                }
                .padding(.bottom, 20)
            }

            // Warning text
            if let warnings = step.warnings {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 16))
                    Text(warnings)
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                }
                .foregroundStyle(.red)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 12)
                        .fill(.red.opacity(0.15))
                )
                .padding(.horizontal, 24)
                .padding(.bottom, 20)
            }

            // Uses outputs badge
            if !step.usesOutputs.isEmpty {
                HStack(spacing: 8) {
                    Text("Uses:")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(.white.opacity(0.6))

                    ForEach(step.usesOutputs, id: \.self) { output in
                        Text(output)
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(
                                Capsule()
                                    .fill(.white.opacity(0.2))
                            )
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
            }
        }
        .frame(maxWidth: 600)
        .background(
            RoundedRectangle(cornerRadius: 32)
                .fill(.ultraThinMaterial)
                .shadow(color: .spenceOrange.opacity(0.3), radius: 20, y: 10)
        )
        .padding(.horizontal, 24)
        .offset(y: isFloating ? -8 : 0)
        .onAppear {
            withAnimation(
                .easeInOut(duration: 3)
                .repeatForever(autoreverses: true)
            ) {
                isFloating = true
            }
        }
    }
}

// MARK: - Sensory Cue Row

struct SensoryCueRow: View {
    let icon: String
    let label: String
    let cue: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundStyle(Color.spenceOrange)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.6))

                Text(cue)
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
            }

            Spacer()
        }
    }
}

// MARK: - Helper Extension

extension CookStep {
    var hasSensoryCues: Bool {
        cueVisual != nil || cueAudio != nil || cueAroma != nil
    }
}

// MARK: - Preview

#Preview("Step Blob - Full") {
    ZStack {
        Color.black.ignoresSafeArea()

        StepBlobView(
            step: CookStep(
                id: 3,
                stepNumber: 3,
                instruction: "Heat oil in a large skillet over medium-high heat until it shimmers and barely begins to smoke",
                timeMinutes: 2,
                usesOutputs: ["Vegetables", "Garlic"],
                cueVisual: "Oil surface ripples and moves quickly",
                cueAudio: "Gentle sizzling when you add a drop of water",
                cueAroma: "Light, warm oil scent (not burning)",
                warnings: "Hot oil can splatter - stand back slightly"
            ),
            stepNumber: 3,
            totalSteps: 8
        )
    }
}

#Preview("Step Blob - Simple") {
    ZStack {
        Color.black.ignoresSafeArea()

        StepBlobView(
            step: CookStep(
                id: 1,
                stepNumber: 1,
                instruction: "Stir gently and cook until vegetables are tender",
                timeMinutes: 5,
                usesOutputs: ["Vegetables"]
            ),
            stepNumber: 1,
            totalSteps: 3
        )
    }
}

#Preview("Step Blob - Warning") {
    ZStack {
        Color.black.ignoresSafeArea()

        StepBlobView(
            step: CookStep(
                id: 8,
                stepNumber: 8,
                instruction: "Carefully remove the hot baking sheet from the oven and transfer to a wire rack",
                cueVisual: "Golden brown edges",
                cueAroma: "Toasted, caramelized aroma",
                warnings: "Use oven mitts - sheet is extremely hot!"
            ),
            stepNumber: 8,
            totalSteps: 8
        )
    }
}
