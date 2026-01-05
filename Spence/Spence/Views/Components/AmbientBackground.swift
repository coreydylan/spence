//
//  AmbientBackground.swift
//  Spence
//
//  Animated gradient background with subtle glowing effects
//

import SwiftUI

/// Ambient animated background with moving radial gradients
///
/// Creates a warm, dynamic background with subtly animated orange and amber glows
/// that pulse and move across a dark base. Optimized for performance with
/// TimelineView and smooth animations.
///
/// Usage:
/// ```swift
/// ZStack {
///     AmbientBackground()
///     // Your content here
/// }
/// ```
struct AmbientBackground: View {
    @State private var glowPosition1: UnitPoint = .topLeading
    @State private var glowPosition2: UnitPoint = .bottomTrailing
    @State private var glowPosition3: UnitPoint = .center
    @State private var glowOpacity1: Double = 0.15
    @State private var glowOpacity2: Double = 0.12
    @State private var glowOpacity3: Double = 0.08

    var body: some View {
        TimelineView(.animation) { timeline in
            ZStack {
                // Base dark warm background
                Color.spenceBackground
                    .ignoresSafeArea()

                // Animated radial gradients
                RadialGradient(
                    colors: [
                        Color.spenceOrange.opacity(glowOpacity1),
                        Color.clear
                    ],
                    center: glowPosition1,
                    startRadius: 0,
                    endRadius: 350
                )
                .ignoresSafeArea()
                .blendMode(.plusLighter)

                RadialGradient(
                    colors: [
                        Color.spenceAmber.opacity(glowOpacity2),
                        Color.clear
                    ],
                    center: glowPosition2,
                    startRadius: 0,
                    endRadius: 300
                )
                .ignoresSafeArea()
                .blendMode(.plusLighter)

                RadialGradient(
                    colors: [
                        Color.spenceOrange.opacity(glowOpacity3),
                        Color.clear
                    ],
                    center: glowPosition3,
                    startRadius: 0,
                    endRadius: 250
                )
                .ignoresSafeArea()
                .blendMode(.plusLighter)

                // Subtle overlay gradient for depth
                LinearGradient(
                    colors: [
                        Color.spenceBackgroundGradientStart.opacity(0.3),
                        Color.clear,
                        Color.spenceBackgroundGradientEnd.opacity(0.3)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                .ignoresSafeArea()
            }
        }
        .onAppear {
            startAnimations()
        }
    }

    /// Starts the ambient glow animations
    private func startAnimations() {
        // Glow 1: Slow circular motion
        withAnimation(
            .easeInOut(duration: 20)
            .repeatForever(autoreverses: true)
        ) {
            glowPosition1 = .bottomTrailing
        }

        withAnimation(
            .easeInOut(duration: 15)
            .repeatForever(autoreverses: true)
        ) {
            glowOpacity1 = 0.08
        }

        // Glow 2: Different timing for variety
        withAnimation(
            .easeInOut(duration: 25)
            .repeatForever(autoreverses: true)
        ) {
            glowPosition2 = .topLeading
        }

        withAnimation(
            .easeInOut(duration: 18)
            .repeatForever(autoreverses: true)
        ) {
            glowOpacity2 = 0.18
        }

        // Glow 3: Center drift
        withAnimation(
            .easeInOut(duration: 22)
            .repeatForever(autoreverses: true)
        ) {
            glowPosition3 = UnitPoint(x: 0.7, y: 0.3)
        }

        withAnimation(
            .easeInOut(duration: 12)
            .repeatForever(autoreverses: true)
        ) {
            glowOpacity3 = 0.15
        }
    }
}

// MARK: - Previews

#Preview("Ambient Background") {
    AmbientBackground()
}

#Preview("With Content") {
    ZStack {
        AmbientBackground()

        VStack(spacing: 24) {
            Text("Spence")
                .font(.system(size: 48, weight: .bold, design: .rounded))
                .foregroundStyle(Color.textPrimary)

            Text("Beautiful ambient background")
                .font(.title3)
                .foregroundStyle(Color.textSecondary)

            RoundedRectangle(cornerRadius: 24)
                .fill(.ultraThinMaterial)
                .frame(width: 300, height: 200)
                .overlay {
                    Text("Glass Card")
                        .foregroundStyle(Color.textPrimary)
                }
        }
        .padding()
    }
}

#Preview("Full Screen Demo") {
    ZStack {
        AmbientBackground()

        ScrollView {
            VStack(spacing: 20) {
                ForEach(0..<5) { index in
                    RoundedRectangle(cornerRadius: 20)
                        .fill(.ultraThinMaterial)
                        .frame(height: 150)
                        .overlay {
                            VStack {
                                Text("Recipe Card \(index + 1)")
                                    .font(.headline)
                                    .foregroundStyle(Color.textPrimary)
                                Text("Animated background creates depth")
                                    .font(.caption)
                                    .foregroundStyle(Color.textSecondary)
                            }
                        }
                }
            }
            .padding()
        }
    }
}
