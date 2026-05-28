//
//  CookPhaseView.swift
//  Spence
//
//  Phase 3: Overview of cooking steps before entering Cook Mode
//

import SwiftUI

struct CookPhaseView: View {
    let recipe: Recipe

    private var sortedSteps: [CookStep] {
        recipe.cookSteps.sorted { $0.stepNumber < $1.stepNumber }
    }

    private var totalCookTime: Int {
        sortedSteps.reduce(0) { total, step in
            total + Int(step.timeMinutes ?? 0)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Header
            cookHeader

            // Steps Overview
            VStack(spacing: 12) {
                ForEach(sortedSteps, id: \.stepNumber) { step in
                    CookStepOverviewCard(step: step, totalSteps: sortedSteps.count)
                }
            }

            // Finishing instructions
            if let finishing = recipe.finishingInstructions {
                finishingSection(finishing)
            }

            // Notes
            if !recipe.notes.isEmpty {
                notesSection(recipe.notes)
            }
        }
    }

    // MARK: - Header

    private var cookHeader: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                SectionHeader(title: "Cooking Steps", icon: "flame")

                Spacer()

                HStack(spacing: 4) {
                    Image(systemName: "clock")
                        .font(.system(size: 12))
                    Text("~\(totalCookTime) min")
                        .font(.spenceCaption)
                }
                .foregroundStyle(Color.textTertiary)
            }

            Text("\(sortedSteps.count) steps • Tap 'Start Cooking' for immersive mode")
                .font(.spenceCaptionSmall)
                .foregroundStyle(Color.textSecondary)
        }
    }

    // MARK: - Finishing Section

    private func finishingSection(_ instructions: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "flag.checkered")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.spenceGreen)

                Text("Finishing")
                    .font(.spenceSubheadline)
                    .foregroundStyle(Color.textPrimary)
            }

            Text(instructions)
                .font(.spenceBody)
                .foregroundStyle(Color.textSecondary)
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.glassLight)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    // MARK: - Notes Section

    private func notesSection(_ notes: [String]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "lightbulb")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.spenceAmber)

                Text("Chef's Notes")
                    .font(.spenceSubheadline)
                    .foregroundStyle(Color.textPrimary)
            }

            VStack(alignment: .leading, spacing: 8) {
                ForEach(notes, id: \.self) { note in
                    HStack(alignment: .top, spacing: 8) {
                        Text("•")
                            .foregroundStyle(Color.spenceAmber)
                        Text(note)
                            .font(.spenceCaption)
                            .foregroundStyle(Color.textSecondary)
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.spenceAmber.opacity(0.1))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color.spenceAmber.opacity(0.2), lineWidth: 1)
            )
        }
    }
}

// MARK: - Cook Step Overview Card

struct CookStepOverviewCard: View {
    let step: CookStep
    let totalSteps: Int

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Step number
            Text("\(step.stepNumber)")
                .font(.stepNumber)
                .foregroundStyle(Color.textSecondary)
                .frame(width: 28, height: 28)
                .background(Color.phaseCook.opacity(0.2))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 8) {
                // Instruction preview
                Text(step.instruction)
                    .font(.spenceBody)
                    .foregroundStyle(Color.textPrimary)
                    .lineLimit(2)

                // Metadata
                HStack(spacing: 12) {
                    // Time
                    if let time = step.timeMinutes, time > 0 {
                        HStack(spacing: 4) {
                            Image(systemName: "clock")
                                .font(.system(size: 11))
                            Text(formatTime(time))
                                .font(.timeBadge)
                        }
                        .foregroundStyle(Color.textTertiary)
                    }

                    // Has sensory cues
                    if hasSensoryCues {
                        HStack(spacing: 4) {
                            if step.cueVisual != nil {
                                Image(systemName: "eye")
                            }
                            if step.cueAudio != nil {
                                Image(systemName: "ear")
                            }
                            if step.cueAroma != nil {
                                Image(systemName: "nose")
                            }
                        }
                        .font(.system(size: 11))
                        .foregroundStyle(Color.spenceAmber)
                    }

                    // Has warning
                    if step.warnings != nil {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(Color.spenceRed)
                    }
                }
            }

            Spacer()

            // Chevron
            Image(systemName: "chevron.right")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.textTertiary)
        }
        .padding(16)
        .background(Color.glassLight)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var hasSensoryCues: Bool {
        step.cueVisual != nil || step.cueAudio != nil || step.cueAroma != nil
    }

    private func formatTime(_ minutes: Double) -> String {
        if minutes < 1 {
            return "\(Int(minutes * 60))s"
        } else if minutes == floor(minutes) {
            return "\(Int(minutes)) min"
        } else {
            return String(format: "%.1f min", minutes)
        }
    }
}

#Preview {
    ScrollView {
        CookPhaseView(recipe: Recipe.preview)
            .padding()
    }
    .background(Color.spenceBackground)
}
