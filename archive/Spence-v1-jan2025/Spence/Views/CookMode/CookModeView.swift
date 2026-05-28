//
//  CookModeView.swift
//  Spence
//
//  THE STAR FEATURE - Immersive full-screen cooking experience
//

import SwiftUI

struct CookModeView: View {
    let recipe: Recipe
    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel: CookModeViewModel
    @GestureState private var dragOffset: CGFloat = 0

    init(recipe: Recipe) {
        self.recipe = recipe
        _viewModel = StateObject(wrappedValue: CookModeViewModel(recipe: recipe))
    }

    var body: some View {
        ZStack {
            // Dark ambient background
            LinearGradient(
                colors: [
                    Color.black.opacity(0.95),
                    Color.phaseCook.opacity(0.3),
                    Color.black.opacity(0.95)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                // Top bar
                topBar
                    .padding(.horizontal, 20)
                    .padding(.top, 8)

                Spacer()

                // Progress dots
                StepProgressDots(
                    currentStep: viewModel.currentStepIndex,
                    totalSteps: viewModel.cookSteps.count,
                    onStepTap: { index in
                        viewModel.jumpToStep(index)
                    }
                )
                .padding(.bottom, 20)

                // Central step blob
                StepBlobView(
                    step: viewModel.currentStep,
                    stepNumber: viewModel.currentStepIndex + 1,
                    totalSteps: viewModel.cookSteps.count
                )
                .transition(.asymmetric(
                    insertion: .scale.combined(with: .opacity),
                    removal: .scale.combined(with: .opacity)
                ))
                .id(viewModel.currentStepIndex)
                .offset(x: dragOffset)
                .gesture(
                    DragGesture()
                        .updating($dragOffset) { value, state, _ in
                            state = value.translation.width
                        }
                        .onEnded { value in
                            handleSwipe(value: value)
                        }
                )

                Spacer()

                // Timer (if active)
                if let timer = viewModel.activeTimer {
                    TimerView(timer: timer)
                        .padding(.bottom, 20)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }

                // Navigation controls
                CookModeControls(
                    canGoPrevious: viewModel.canGoPrevious,
                    canGoNext: viewModel.canGoNext,
                    onPrevious: {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            viewModel.previousStep()
                        }
                    },
                    onNext: {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            viewModel.nextStep()
                        }
                    }
                )
                .padding(.horizontal, 20)
                .padding(.bottom, 30)
            }
        }
        .statusBarHidden()
        .onAppear {
            viewModel.startCookMode()
        }
        .onDisappear {
            viewModel.stopCookMode()
        }
    }

    private var topBar: some View {
        HStack {
            // Exit button
            Button(action: {
                viewModel.stopCookMode()
                dismiss()
            }) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(.white.opacity(0.8))
                    .background(
                        Circle()
                            .fill(.ultraThinMaterial)
                            .frame(width: 44, height: 44)
                    )
            }

            Spacer()

            // Step progress indicator
            Text("Step \(viewModel.currentStepIndex + 1) of \(viewModel.cookSteps.count)")
                .font(.system(size: 16, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.7))
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(
                    Capsule()
                        .fill(.ultraThinMaterial)
                )

            Spacer()

            // Invisible spacer for symmetry
            Color.clear
                .frame(width: 44, height: 44)
        }
    }

    private func handleSwipe(value: DragGesture.Value) {
        let threshold: CGFloat = 100

        if value.translation.width > threshold {
            // Swipe right - previous
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                viewModel.previousStep()
            }
        } else if value.translation.width < -threshold {
            // Swipe left - next
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                viewModel.nextStep()
            }
        }
    }
}

// MARK: - ViewModel

@MainActor
class CookModeViewModel: ObservableObject {
    let recipe: Recipe
    @Published var currentStepIndex: Int = 0
    @Published var activeTimer: CookTimer?

    var cookSteps: [CookStep] {
        recipe.cookSteps
    }

    var currentStep: CookStep {
        cookSteps[currentStepIndex]
    }

    var canGoPrevious: Bool {
        currentStepIndex > 0
    }

    var canGoNext: Bool {
        currentStepIndex < cookSteps.count - 1
    }

    init(recipe: Recipe) {
        self.recipe = recipe
    }

    func startCookMode() {
        // Keep screen awake during cook mode
        UIApplication.shared.isIdleTimerDisabled = true

        // Start timer for first step if it has one
        startTimerForCurrentStep()
    }

    func stopCookMode() {
        // Allow screen to sleep again
        UIApplication.shared.isIdleTimerDisabled = false

        // Stop any active timer
        activeTimer?.stop()
        activeTimer = nil
    }

    func nextStep() {
        guard canGoNext else { return }

        // Haptic feedback
        let impact = UIImpactFeedbackGenerator(style: .medium)
        impact.impactOccurred()

        currentStepIndex += 1
        startTimerForCurrentStep()
    }

    func previousStep() {
        guard canGoPrevious else { return }

        // Haptic feedback
        let impact = UIImpactFeedbackGenerator(style: .light)
        impact.impactOccurred()

        currentStepIndex -= 1
        startTimerForCurrentStep()
    }

    func jumpToStep(_ index: Int) {
        guard index >= 0 && index < cookSteps.count else { return }

        // Haptic feedback
        let impact = UIImpactFeedbackGenerator(style: .medium)
        impact.impactOccurred()

        currentStepIndex = index
        startTimerForCurrentStep()
    }

    private func startTimerForCurrentStep() {
        // Stop existing timer
        activeTimer?.stop()
        activeTimer = nil

        // Start new timer if step has time
        if let timeMinutes = currentStep.timeMinutes, timeMinutes > 0 {
            let timer = CookTimer(durationMinutes: timeMinutes)
            activeTimer = timer
            timer.start()
        }
    }
}

// MARK: - Preview

#Preview("Cook Mode - Full Recipe") {
    CookModeView(recipe: Recipe.fullExample)
}

#Preview("Cook Mode - Simple Recipe") {
    CookModeView(recipe: Recipe(
        name: "Simple Pasta",
        source: "Test Kitchen",
        yieldText: "2 servings",
        prepMinutes: 5,
        cookMinutes: 12,
        totalMinutes: 17,
        notes: ["Cook until al dente"],
        cookSteps: [
            CookStep(
                id: 1,
                stepNumber: 1,
                instruction: "Bring a large pot of salted water to a rolling boil",
                timeMinutes: 5,
                cueVisual: "Large bubbles breaking the surface",
                cueAudio: "Rapid bubbling sound",
                warnings: "Be careful of steam"
            ),
            CookStep(
                id: 2,
                stepNumber: 2,
                instruction: "Add pasta and stir gently to prevent sticking",
                timeMinutes: 8,
                cueVisual: "Pasta moving freely in water",
                cueAudio: "Gentle bubbling",
                cueAroma: "Fresh pasta aroma"
            ),
            CookStep(
                id: 3,
                stepNumber: 3,
                instruction: "Drain pasta and serve immediately",
                cueVisual: "Al dente texture",
                warnings: "Hot water - use oven mitts"
            )
        ]
    ))
}
