//
//  CookModeControls.swift
//  Spence
//
//  Bottom navigation controls for cook mode
//

import SwiftUI

struct CookModeControls: View {
    let canGoPrevious: Bool
    let canGoNext: Bool
    let onPrevious: () -> Void
    let onNext: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            // Voice hint
            HStack(spacing: 6) {
                Image(systemName: "waveform")
                    .font(.system(size: 12))
                Text("Say \"Next\" or swipe")
                    .font(.system(size: 13, weight: .medium, design: .rounded))
            }
            .foregroundStyle(.white.opacity(0.5))

            // Navigation buttons
            HStack(spacing: 16) {
                // Previous button
                Button(action: onPrevious) {
                    HStack(spacing: 8) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 18, weight: .semibold))
                        Text("Previous")
                            .font(.system(size: 16, weight: .semibold, design: .rounded))
                    }
                    .foregroundStyle(canGoPrevious ? .white : .white.opacity(0.3))
                    .frame(maxWidth: .infinity)
                    .frame(height: 56)
                    .background(
                        RoundedRectangle(cornerRadius: 16)
                            .fill(.ultraThinMaterial)
                            .opacity(canGoPrevious ? 1 : 0.5)
                    )
                }
                .disabled(!canGoPrevious)

                // Next button (larger and more prominent)
                Button(action: onNext) {
                    HStack(spacing: 8) {
                        Text("Next")
                            .font(.system(size: 18, weight: .bold, design: .rounded))
                        Image(systemName: "chevron.right")
                            .font(.system(size: 18, weight: .semibold))
                    }
                    .foregroundStyle(canGoNext ? .white : .white.opacity(0.3))
                    .frame(maxWidth: .infinity)
                    .frame(height: 64)
                    .background(
                        RoundedRectangle(cornerRadius: 18)
                            .fill(
                                canGoNext
                                    ? LinearGradient(
                                        colors: [Color.spenceOrange, Color.spenceOrange.opacity(0.8)],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                    : LinearGradient(
                                        colors: [Color.gray.opacity(0.3), Color.gray.opacity(0.2)],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                            )
                            .shadow(
                                color: canGoNext ? Color.spenceOrange.opacity(0.4) : .clear,
                                radius: 15,
                                y: 5
                            )
                    )
                }
                .disabled(!canGoNext)
                .scaleEffect(canGoNext ? 1.0 : 0.95)
                .animation(.spring(response: 0.3, dampingFraction: 0.7), value: canGoNext)
            }
        }
    }
}

// MARK: - Preview

#Preview("Controls - Both Enabled") {
    ZStack {
        Color.black.ignoresSafeArea()

        VStack {
            Spacer()
            CookModeControls(
                canGoPrevious: true,
                canGoNext: true,
                onPrevious: {},
                onNext: {}
            )
            .padding(.horizontal, 20)
            .padding(.bottom, 30)
        }
    }
}

#Preview("Controls - First Step") {
    ZStack {
        Color.black.ignoresSafeArea()

        VStack {
            Spacer()
            CookModeControls(
                canGoPrevious: false,
                canGoNext: true,
                onPrevious: {},
                onNext: {}
            )
            .padding(.horizontal, 20)
            .padding(.bottom, 30)
        }
    }
}

#Preview("Controls - Last Step") {
    ZStack {
        Color.black.ignoresSafeArea()

        VStack {
            Spacer()
            CookModeControls(
                canGoPrevious: true,
                canGoNext: false,
                onPrevious: {},
                onNext: {}
            )
            .padding(.horizontal, 20)
            .padding(.bottom, 30)
        }
    }
}

#Preview("Controls - Only Step") {
    ZStack {
        Color.black.ignoresSafeArea()

        VStack {
            Spacer()
            CookModeControls(
                canGoPrevious: false,
                canGoNext: false,
                onPrevious: {},
                onNext: {}
            )
            .padding(.horizontal, 20)
            .padding(.bottom, 30)
        }
    }
}
