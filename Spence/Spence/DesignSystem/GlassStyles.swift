//
//  GlassStyles.swift
//  Spence
//
//  Glass morphism effects and card styling with intensity controls
//

import SwiftUI

// MARK: - Glass Intensity

/// Defines the intensity level for glass morphism effects
enum GlassIntensity {
    case light
    case medium
    case heavy

    /// Background overlay color based on intensity
    var backgroundColor: Color {
        switch self {
        case .light:
            return .glassLight
        case .medium:
            return .glassMedium
        case .heavy:
            return .glassHeavy
        }
    }

    /// Blur material strength
    var material: Material {
        switch self {
        case .light:
            return .ultraThinMaterial
        case .medium:
            return .thinMaterial
        case .heavy:
            return .regularMaterial
        }
    }

    /// Shadow opacity for depth
    var shadowOpacity: Double {
        switch self {
        case .light:
            return 0.2
        case .medium:
            return 0.25
        case .heavy:
            return 0.3
        }
    }

    /// Border opacity
    var borderOpacity: Double {
        switch self {
        case .light:
            return 0.1
        case .medium:
            return 0.15
        case .heavy:
            return 0.2
        }
    }
}

// MARK: - Glass Card Modifier

/// Applies glass morphism styling to any view
struct GlassCardModifier: ViewModifier {
    let intensity: GlassIntensity
    let cornerRadius: CGFloat

    init(intensity: GlassIntensity = .medium, cornerRadius: CGFloat = 24) {
        self.intensity = intensity
        self.cornerRadius = cornerRadius
    }

    func body(content: Content) -> some View {
        content
            .background {
                ZStack {
                    // Glass blur layer
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(intensity.backgroundColor)
                        .background(
                            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                                .fill(intensity.material)
                        )

                    // Subtle inner gradient for depth
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.white.opacity(0.08),
                                    Color.clear
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                }
            }
            .overlay {
                // Border stroke
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(
                        Color.white.opacity(intensity.borderOpacity),
                        lineWidth: 1
                    )
            }
            .shadow(
                color: .black.opacity(intensity.shadowOpacity),
                radius: 20,
                x: 0,
                y: 10
            )
    }
}

// MARK: - Glass Button Modifier

/// Glass style specifically for interactive buttons with press feedback
struct GlassButtonModifier: ViewModifier {
    let intensity: GlassIntensity
    let cornerRadius: CGFloat
    @State private var isPressed = false

    init(intensity: GlassIntensity = .medium, cornerRadius: CGFloat = 16) {
        self.intensity = intensity
        self.cornerRadius = cornerRadius
    }

    func body(content: Content) -> some View {
        content
            .background {
                ZStack {
                    // Glass blur layer
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(intensity.backgroundColor)
                        .background(
                            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                                .fill(intensity.material)
                        )

                    // Interactive gradient that responds to press
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.white.opacity(isPressed ? 0.15 : 0.08),
                                    Color.clear
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(
                        Color.white.opacity(intensity.borderOpacity),
                        lineWidth: 1
                    )
            }
            .shadow(
                color: .black.opacity(isPressed ? intensity.shadowOpacity * 0.5 : intensity.shadowOpacity),
                radius: isPressed ? 10 : 20,
                x: 0,
                y: isPressed ? 5 : 10
            )
            .scaleEffect(isPressed ? 0.98 : 1.0)
            .animation(.springy, value: isPressed)
            .simultaneousGesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in isPressed = true }
                    .onEnded { _ in isPressed = false }
            )
    }
}

// MARK: - Glass Badge Modifier

/// Small glass badge for pills, tags, and labels
struct GlassBadge: ViewModifier {
    let intensity: GlassIntensity
    let cornerRadius: CGFloat

    init(intensity: GlassIntensity = .light, cornerRadius: CGFloat = 12) {
        self.intensity = intensity
        self.cornerRadius = cornerRadius
    }

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background {
                Capsule()
                    .fill(intensity.backgroundColor)
                    .background(
                        Capsule()
                            .fill(intensity.material)
                    )
            }
            .overlay {
                Capsule()
                    .strokeBorder(
                        Color.white.opacity(intensity.borderOpacity),
                        lineWidth: 0.5
                    )
            }
            .shadow(
                color: .black.opacity(intensity.shadowOpacity * 0.7),
                radius: 8,
                x: 0,
                y: 4
            )
    }
}

// MARK: - Glass Overlay Modifier

/// Full-screen glass overlay for modals and popovers
struct GlassOverlay: ViewModifier {
    let intensity: GlassIntensity
    let edges: Edge.Set

    init(intensity: GlassIntensity = .heavy, ignoresSafeAreaEdges edges: Edge.Set = .all) {
        self.intensity = intensity
        self.edges = edges
    }

    func body(content: Content) -> some View {
        content
            .background {
                Rectangle()
                    .fill(intensity.material)
                    .overlay {
                        Rectangle()
                            .fill(intensity.backgroundColor)
                    }
                    .ignoresSafeArea(edges: edges)
            }
    }
}

// MARK: - Convenience Extensions

extension View {
    /// Apply glass card styling
    func glassCard(
        intensity: GlassIntensity = .medium,
        cornerRadius: CGFloat = 24
    ) -> some View {
        modifier(GlassCardModifier(intensity: intensity, cornerRadius: cornerRadius))
    }

    /// Apply glass button styling with press feedback
    func glassButton(
        intensity: GlassIntensity = .medium,
        cornerRadius: CGFloat = 16
    ) -> some View {
        modifier(GlassButtonModifier(intensity: intensity, cornerRadius: cornerRadius))
    }

    /// Apply glass badge styling
    func glassBadge(
        intensity: GlassIntensity = .light,
        cornerRadius: CGFloat = 12
    ) -> some View {
        modifier(GlassBadge(intensity: intensity, cornerRadius: cornerRadius))
    }

    /// Apply full-screen glass overlay
    func glassOverlay(
        intensity: GlassIntensity = .heavy,
        ignoresSafeAreaEdges edges: Edge.Set = .all
    ) -> some View {
        modifier(GlassOverlay(intensity: intensity, ignoresSafeAreaEdges: edges))
    }
}

// MARK: - Animated Glass Effects

/// Glass card with animated shimmer effect
struct AnimatedGlassCard: ViewModifier {
    let intensity: GlassIntensity
    let cornerRadius: CGFloat
    @State private var shimmerOffset: CGFloat = -200

    init(intensity: GlassIntensity = .medium, cornerRadius: CGFloat = 24) {
        self.intensity = intensity
        self.cornerRadius = cornerRadius
    }

    func body(content: Content) -> some View {
        content
            .background {
                ZStack {
                    // Base glass layer
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(intensity.backgroundColor)
                        .background(
                            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                                .fill(intensity.material)
                        )

                    // Animated shimmer
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.clear,
                                    Color.white.opacity(0.1),
                                    Color.clear
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .offset(x: shimmerOffset)
                        .mask(
                            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        )
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(
                        Color.white.opacity(intensity.borderOpacity),
                        lineWidth: 1
                    )
            }
            .shadow(
                color: .black.opacity(intensity.shadowOpacity),
                radius: 20,
                x: 0,
                y: 10
            )
            .onAppear {
                withAnimation(.linear(duration: 2).repeatForever(autoreverses: false)) {
                    shimmerOffset = 200
                }
            }
    }
}

extension View {
    /// Apply animated glass card with shimmer effect
    func animatedGlassCard(
        intensity: GlassIntensity = .medium,
        cornerRadius: CGFloat = 24
    ) -> some View {
        modifier(AnimatedGlassCard(intensity: intensity, cornerRadius: cornerRadius))
    }
}
