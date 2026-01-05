//
//  PrepPhaseView.swift
//  Spence
//
//  Phase 2: Mise en place - all prep work before cooking
//

import SwiftUI

struct PrepPhaseView: View {
    let recipe: Recipe
    @State private var completedSteps: Set<Int> = []

    private var sortedSteps: [PrepStep] {
        recipe.prepSteps.sorted { $0.stepNumber < $1.stepNumber }
    }

    private var progress: Double {
        guard !sortedSteps.isEmpty else { return 1.0 }
        return Double(completedSteps.count) / Double(sortedSteps.count)
    }

    private var totalPrepTime: Int {
        sortedSteps.reduce(0) { $0 + Int($1.timeMinutes ?? 0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Progress Header
            prepProgressHeader

            // Steps List
            VStack(spacing: 12) {
                ForEach(sortedSteps, id: \.stepNumber) { step in
                    PrepStepCard(
                        step: step,
                        isCompleted: completedSteps.contains(step.stepNumber),
                        onToggle: { toggleStep(step.stepNumber) }
                    )
                }
            }

            // Completion Banner
            if completedSteps.count == sortedSteps.count && !sortedSteps.isEmpty {
                prepCompleteBanner
            }
        }
    }

    // MARK: - Progress Header

    private var prepProgressHeader: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                SectionHeader(title: "Mise en Place", icon: "knife")

                Spacer()

                // Time estimate
                HStack(spacing: 4) {
                    Image(systemName: "clock")
                        .font(.system(size: 12))
                    Text("~\(totalPrepTime) min")
                        .font(.spenceCaption)
                }
                .foregroundStyle(Color.textTertiary)
            }

            // Progress bar
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.glassLight)
                        .frame(height: 8)

                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.phasePrep)
                        .frame(width: geo.size.width * progress, height: 8)
                        .animation(.smooth, value: progress)
                }
            }
            .frame(height: 8)

            // Step count
            Text("\(completedSteps.count) of \(sortedSteps.count) steps complete")
                .font(.spenceCaptionSmall)
                .foregroundStyle(Color.textSecondary)
        }
    }

    // MARK: - Completion Banner

    private var prepCompleteBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 28))
                .foregroundStyle(Color.phasePrep)

            VStack(alignment: .leading, spacing: 2) {
                Text("Prep complete!")
                    .font(.spenceSubheadline)
                    .foregroundStyle(Color.textPrimary)
                Text("Nothing left to chop mid-cook")
                    .font(.spenceCaption)
                    .foregroundStyle(Color.textSecondary)
            }

            Spacer()
        }
        .padding(16)
        .background(Color.phasePrep.opacity(0.15))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.phasePrep.opacity(0.3), lineWidth: 1)
        )
    }

    private func toggleStep(_ stepNumber: Int) {
        withAnimation(.smooth) {
            if completedSteps.contains(stepNumber) {
                completedSteps.remove(stepNumber)
            } else {
                completedSteps.insert(stepNumber)
            }
        }
    }
}

// MARK: - Prep Step Card

struct PrepStepCard: View {
    let step: PrepStep
    let isCompleted: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(alignment: .top, spacing: 12) {
                // Step number / check
                ZStack {
                    Circle()
                        .stroke(isCompleted ? Color.phasePrep : Color.glassBorder, lineWidth: 2)
                        .frame(width: 32, height: 32)

                    if isCompleted {
                        Image(systemName: "checkmark")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(Color.phasePrep)
                    } else {
                        Text("\(step.stepNumber)")
                            .font(.stepNumber)
                            .foregroundStyle(Color.textSecondary)
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    // Instruction
                    Text(step.instruction)
                        .font(.stepInstruction)
                        .foregroundStyle(isCompleted ? Color.textSecondary : Color.textPrimary)
                        .strikethrough(isCompleted)
                        .multilineTextAlignment(.leading)

                    // Metadata row
                    HStack(spacing: 12) {
                        // Time
                        if let time = step.timeMinutes, time > 0 {
                            HStack(spacing: 4) {
                                Image(systemName: "clock")
                                    .font(.system(size: 11))
                                Text("\(time) min")
                                    .font(.timeBadge)
                            }
                            .foregroundStyle(Color.textTertiary)
                        }

                        // Station
                        if let station = step.station {
                            StationBadge(station: station)
                        }

                        // Container destination
                        if let container = step.container {
                            HStack(spacing: 4) {
                                Image(systemName: "arrow.right")
                                    .font(.system(size: 10))
                                Text(container)
                                    .font(.timeBadge)
                            }
                            .foregroundStyle(Color.spenceAmber)
                        }
                    }

                    // Outputs
                    if !step.outputs.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(step.outputs, id: \.self) { output in
                                Text(output)
                                    .font(.spenceFootnote)
                                    .foregroundStyle(Color.textSecondary)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(Color.glassMedium)
                                    .clipShape(Capsule())
                            }
                        }
                    }

                    // Notes
                    if let notes = step.notes {
                        Text(notes)
                            .font(.spenceCaptionSmall)
                            .foregroundStyle(Color.textTertiary)
                            .italic()
                    }
                }

                Spacer()
            }
            .padding(16)
            .background(Color.glassLight)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(isCompleted ? Color.phasePrep.opacity(0.3) : Color.clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Station Badge

struct StationBadge: View {
    let station: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: stationIcon)
                .font(.system(size: 11))
            Text(station)
                .font(.timeBadge)
        }
        .foregroundStyle(stationColor)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(stationColor.opacity(0.15))
        .clipShape(Capsule())
    }

    private var stationIcon: String {
        switch station.lowercased() {
        case "knife": return "scissors"
        case "measuring": return "ruler"
        case "sink": return "drop"
        case "mixing": return "arrow.triangle.2.circlepath"
        case "setup": return "square.grid.2x2"
        case "prep-cooking": return "flame"
        default: return "circle"
        }
    }

    private var stationColor: Color {
        switch station.lowercased() {
        case "knife": return .spenceRed
        case "measuring": return .spenceBlue
        case "sink": return .spenceBlue
        case "mixing": return .spenceAmber
        case "setup": return .spenceGreen
        case "prep-cooking": return .spenceOrange
        default: return .textTertiary
        }
    }
}

#Preview {
    ScrollView {
        PrepPhaseView(recipe: Recipe.preview)
            .padding()
    }
    .background(Color.spenceBackground)
}
