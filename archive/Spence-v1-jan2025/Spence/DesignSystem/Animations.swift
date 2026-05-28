//
//  Animations.swift
//  Spence
//
//  Shared animation curves and timing functions for consistent motion
//

import SwiftUI

// MARK: - Standard Animation Curves

extension Animation {
    /// Springy animation - playful and natural (response: 0.5, damping: 0.7)
    /// Use for: Interactive elements, button presses, card transitions
    static let springy = Animation.spring(response: 0.5, dampingFraction: 0.7)

    /// Smooth animation - balanced ease in/out (0.3s)
    /// Use for: General UI transitions, modal presentations, navigation
    static let smooth = Animation.easeInOut(duration: 0.3)

    /// Quick animation - snappy feedback (0.2s)
    /// Use for: Micro-interactions, toggles, state changes
    static let quick = Animation.easeOut(duration: 0.2)

    /// Gentle animation - relaxed and calm (0.5s)
    /// Use for: Background elements, ambient effects, large movements
    static let gentle = Animation.easeInOut(duration: 0.5)

    /// Bouncy spring - more pronounced bounce
    /// Use for: Celebratory actions, completion feedback
    static let bouncy = Animation.spring(response: 0.6, dampingFraction: 0.6)

    /// Snappy spring - very responsive
    /// Use for: Immediate feedback, interactive dragging
    static let snappy = Animation.spring(response: 0.3, dampingFraction: 0.8)

    /// Fluid spring - smooth with slight overshoot
    /// Use for: Card animations, sheet presentations
    static let fluid = Animation.spring(response: 0.4, dampingFraction: 0.75)

    /// Soft ease - very gentle entry/exit
    /// Use for: Fade effects, subtle state changes
    static let soft = Animation.easeInOut(duration: 0.4)
}

// MARK: - Cook Mode Animations

extension Animation {
    /// Blob animation for cook mode step transitions
    /// Creates an organic, flowing transition between steps
    static let blob = Animation.spring(
        response: 0.7,
        dampingFraction: 0.65,
        blendDuration: 0.3
    )

    /// Step advance - forward progression in cook mode
    static let stepAdvance = Animation.spring(
        response: 0.5,
        dampingFraction: 0.7
    ).delay(0.1)

    /// Step retreat - backward navigation in cook mode
    static let stepRetreat = Animation.spring(
        response: 0.4,
        dampingFraction: 0.8
    )

    /// Timer pulse - rhythmic animation for active timers
    static func timerPulse(speed: Double = 1.0) -> Animation {
        Animation.easeInOut(duration: 1.0 / speed)
            .repeatForever(autoreverses: true)
    }

    /// Phase transition - smooth transition between CHECK/PREP/COOK phases
    static let phaseTransition = Animation.spring(
        response: 0.6,
        dampingFraction: 0.7
    ).delay(0.05)
}

// MARK: - Specialized Animations

extension Animation {
    /// Card flip animation
    static let cardFlip = Animation.spring(
        response: 0.5,
        dampingFraction: 0.75
    )

    /// Slide in from edge
    static let slideIn = Animation.spring(
        response: 0.4,
        dampingFraction: 0.85
    )

    /// Slide out to edge
    static let slideOut = Animation.easeIn(duration: 0.25)

    /// Scale up animation (for appearing elements)
    static let scaleUp = Animation.spring(
        response: 0.4,
        dampingFraction: 0.7
    )

    /// Scale down animation (for dismissing elements)
    static let scaleDown = Animation.easeIn(duration: 0.2)

    /// Fade in animation
    static let fadeIn = Animation.easeOut(duration: 0.3)

    /// Fade out animation
    static let fadeOut = Animation.easeIn(duration: 0.2)

    /// Shimmer effect for loading states
    static let shimmer = Animation.linear(duration: 1.5)
        .repeatForever(autoreverses: false)

    /// Ambient glow animation for background effects
    static let ambientGlow = Animation.easeInOut(duration: 3.0)
        .repeatForever(autoreverses: true)
}

// MARK: - Animation Modifiers

/// Animated transition that applies both scale and opacity
struct AppearTransition: ViewModifier {
    let isVisible: Bool
    let animation: Animation

    func body(content: Content) -> some View {
        content
            .scaleEffect(isVisible ? 1.0 : 0.8)
            .opacity(isVisible ? 1.0 : 0.0)
            .animation(animation, value: isVisible)
    }
}

/// Animated slide transition
struct SlideTransition: ViewModifier {
    let isVisible: Bool
    let edge: Edge
    let animation: Animation
    let offset: CGFloat

    func body(content: Content) -> some View {
        content
            .offset(
                x: edge == .leading ? (isVisible ? 0 : -offset) :
                   edge == .trailing ? (isVisible ? 0 : offset) : 0,
                y: edge == .top ? (isVisible ? 0 : -offset) :
                   edge == .bottom ? (isVisible ? 0 : offset) : 0
            )
            .opacity(isVisible ? 1.0 : 0.0)
            .animation(animation, value: isVisible)
    }
}

/// Shimmer effect for loading states
struct ShimmerEffect: ViewModifier {
    @State private var shimmerOffset: CGFloat = -200
    let isActive: Bool

    func body(content: Content) -> some View {
        content
            .overlay {
                if isActive {
                    GeometryReader { geometry in
                        LinearGradient(
                            colors: [
                                Color.clear,
                                Color.white.opacity(0.3),
                                Color.clear
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: geometry.size.width * 0.3)
                        .offset(x: shimmerOffset)
                        .onAppear {
                            withAnimation(.shimmer) {
                                shimmerOffset = geometry.size.width + 200
                            }
                        }
                    }
                    .allowsHitTesting(false)
                }
            }
    }
}

/// Pulse animation for emphasis
struct PulseEffect: ViewModifier {
    let isActive: Bool
    let minScale: CGFloat
    let maxScale: CGFloat
    @State private var isPulsing = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(isPulsing ? maxScale : minScale)
            .onChange(of: isActive) { _, newValue in
                if newValue {
                    withAnimation(.timerPulse()) {
                        isPulsing.toggle()
                    }
                } else {
                    isPulsing = false
                }
            }
    }
}

/// Breathing animation for ambient elements
struct BreathingEffect: ViewModifier {
    let isActive: Bool
    @State private var scale: CGFloat = 1.0
    @State private var opacity: Double = 0.6

    func body(content: Content) -> some View {
        content
            .scaleEffect(scale)
            .opacity(opacity)
            .onAppear {
                if isActive {
                    withAnimation(.ambientGlow) {
                        scale = 1.1
                        opacity = 0.8
                    }
                }
            }
            .onChange(of: isActive) { _, newValue in
                if newValue {
                    withAnimation(.ambientGlow) {
                        scale = 1.1
                        opacity = 0.8
                    }
                } else {
                    scale = 1.0
                    opacity = 0.6
                }
            }
    }
}

// MARK: - Convenience Extensions

extension View {
    /// Apply appear transition with scale and opacity
    func appearTransition(
        isVisible: Bool,
        animation: Animation = .springy
    ) -> some View {
        modifier(AppearTransition(isVisible: isVisible, animation: animation))
    }

    /// Apply slide transition from edge
    func slideTransition(
        isVisible: Bool,
        from edge: Edge,
        offset: CGFloat = 100,
        animation: Animation = .slideIn
    ) -> some View {
        modifier(SlideTransition(
            isVisible: isVisible,
            edge: edge,
            animation: animation,
            offset: offset
        ))
    }

    /// Apply shimmer loading effect
    func shimmer(isActive: Bool = true) -> some View {
        modifier(ShimmerEffect(isActive: isActive))
    }

    /// Apply pulse effect
    func pulse(
        isActive: Bool = true,
        minScale: CGFloat = 1.0,
        maxScale: CGFloat = 1.05
    ) -> some View {
        modifier(PulseEffect(
            isActive: isActive,
            minScale: minScale,
            maxScale: maxScale
        ))
    }

    /// Apply breathing animation for ambient elements
    func breathing(isActive: Bool = true) -> some View {
        modifier(BreathingEffect(isActive: isActive))
    }
}

// MARK: - Custom Transitions

extension AnyTransition {
    /// Scale and fade transition
    static var scaleAndFade: AnyTransition {
        .scale(scale: 0.8).combined(with: .opacity)
    }

    /// Slide from bottom with fade
    static var slideFromBottom: AnyTransition {
        .move(edge: .bottom).combined(with: .opacity)
    }

    /// Slide from top with fade
    static var slideFromTop: AnyTransition {
        .move(edge: .top).combined(with: .opacity)
    }

    /// Slide from leading with fade
    static var slideFromLeading: AnyTransition {
        .move(edge: .leading).combined(with: .opacity)
    }

    /// Slide from trailing with fade
    static var slideFromTrailing: AnyTransition {
        .move(edge: .trailing).combined(with: .opacity)
    }

    /// Blob transition for cook mode steps
    static var blob: AnyTransition {
        .asymmetric(
            insertion: .scale(scale: 0.9).combined(with: .opacity),
            removal: .scale(scale: 1.1).combined(with: .opacity)
        )
    }

    /// Card flip transition
    static var flip: AnyTransition {
        .modifier(
            active: FlipModifier(rotation: 90),
            identity: FlipModifier(rotation: 0)
        )
    }
}

// MARK: - Supporting Types

private struct FlipModifier: ViewModifier {
    let rotation: Double

    func body(content: Content) -> some View {
        content
            .rotation3DEffect(
                .degrees(rotation),
                axis: (x: 0.0, y: 1.0, z: 0.0),
                perspective: 0.5
            )
            .opacity(rotation == 90 ? 0 : 1)
    }
}

// MARK: - Animation Timing Functions

/// Provides precise timing values for coordinated animations
enum AnimationTiming {
    /// Very quick feedback (0.15s)
    static let instant: TimeInterval = 0.15

    /// Quick interaction (0.2s)
    static let quick: TimeInterval = 0.2

    /// Standard UI transition (0.3s)
    static let standard: TimeInterval = 0.3

    /// Moderate transition (0.4s)
    static let moderate: TimeInterval = 0.4

    /// Leisurely transition (0.5s)
    static let leisurely: TimeInterval = 0.5

    /// Slow, dramatic effect (0.7s)
    static let dramatic: TimeInterval = 0.7

    /// Very slow, ambient effect (1.0s+)
    static let ambient: TimeInterval = 1.0
}

// MARK: - Delay Helpers

extension Animation {
    /// Create animation with standard delay increments
    func withDelay(_ delay: TimeInterval) -> Animation {
        self.delay(delay)
    }

    /// Create staggered animation for sequential items
    static func staggered(index: Int, baseDelay: TimeInterval = 0.05) -> Animation {
        .springy.delay(Double(index) * baseDelay)
    }
}
