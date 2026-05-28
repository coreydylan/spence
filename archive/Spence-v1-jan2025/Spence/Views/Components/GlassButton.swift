//
//  GlassButton.swift
//  Spence
//
//  Translucent button styles with haptic feedback
//

import SwiftUI

/// Button style variants for the glass UI design system
enum GlassButtonStyle {
    /// Primary style with orange accent and higher opacity
    case primary
    /// Secondary style with subtle glass effect
    case secondary
    /// Ghost style with just text and no background
    case ghost
}

/// A translucent button with glass morphism effects and haptic feedback
///
/// Features:
/// - Three style variants: primary, secondary, ghost
/// - Pressed state with scale animation
/// - Haptic feedback on tap
/// - Configurable size and shape
/// - Icon support
///
/// Usage:
/// ```swift
/// GlassButton("Continue", style: .primary) {
///     // Action
/// }
///
/// GlassButton("Cancel", systemImage: "xmark", style: .secondary) {
///     // Action
/// }
/// ```
struct GlassButton: View {
    let title: String
    let systemImage: String?
    let style: GlassButtonStyle
    let action: () -> Void

    @State private var isPressed = false

    /// Creates a glass button
    ///
    /// - Parameters:
    ///   - title: Button text
    ///   - systemImage: Optional SF Symbol name
    ///   - style: Visual style variant (default: .primary)
    ///   - action: Closure to execute on tap
    init(
        _ title: String,
        systemImage: String? = nil,
        style: GlassButtonStyle = .primary,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.style = style
        self.action = action
    }

    var body: some View {
        Button {
            // Haptic feedback
            let impact = UIImpactFeedbackGenerator(style: .medium)
            impact.impactOccurred()

            action()
        } label: {
            HStack(spacing: 8) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.body.weight(.semibold))
                }
                Text(title)
                    .font(.body.weight(.semibold))
            }
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .frame(maxWidth: maxWidth)
            .background(background)
            .overlay(border)
            .foregroundStyle(foregroundColor)
            .shadow(color: shadowColor, radius: shadowRadius, x: 0, y: shadowOffset)
        }
        .buttonStyle(ScaleButtonStyle())
    }

    // MARK: - Style Properties

    private var horizontalPadding: CGFloat {
        switch style {
        case .primary, .secondary: return 24
        case .ghost: return 16
        }
    }

    private var verticalPadding: CGFloat {
        switch style {
        case .primary, .secondary: return 16
        case .ghost: return 12
        }
    }

    private var maxWidth: CGFloat? {
        switch style {
        case .primary: return .infinity
        case .secondary, .ghost: return nil
        }
    }

    @ViewBuilder
    private var background: some View {
        switch style {
        case .primary:
            RoundedRectangle(cornerRadius: 16)
                .fill(
                    LinearGradient(
                        colors: [
                            Color.spenceOrange,
                            Color.spenceOrange.opacity(0.8)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .fill(.ultraThinMaterial)
                        .opacity(0.3)
                )

        case .secondary:
            RoundedRectangle(cornerRadius: 16)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .fill(Color.glassMedium)
                )

        case .ghost:
            Color.clear
        }
    }

    @ViewBuilder
    private var border: some View {
        switch style {
        case .primary:
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(
                    Color.white.opacity(0.3),
                    lineWidth: 1
                )

        case .secondary:
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(Color.glassBorder, lineWidth: 1)

        case .ghost:
            EmptyView()
        }
    }

    private var foregroundColor: Color {
        switch style {
        case .primary: return .white
        case .secondary: return Color.textPrimary
        case .ghost: return Color.textSecondary
        }
    }

    private var shadowColor: Color {
        switch style {
        case .primary: return Color.spenceOrange.opacity(0.4)
        case .secondary: return Color.glassShadow.opacity(0.2)
        case .ghost: return .clear
        }
    }

    private var shadowRadius: CGFloat {
        switch style {
        case .primary: return 20
        case .secondary: return 10
        case .ghost: return 0
        }
    }

    private var shadowOffset: CGFloat {
        switch style {
        case .primary: return 8
        case .secondary: return 4
        case .ghost: return 0
        }
    }
}

// MARK: - Scale Button Style

/// Button style that scales down on press
private struct ScaleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1.0)
            .animation(.easeInOut(duration: 0.15), value: configuration.isPressed)
    }
}

// MARK: - Convenience Initializers

extension GlassButton {
    /// Creates a primary button with icon
    static func primary(
        _ title: String,
        systemImage: String? = nil,
        action: @escaping () -> Void
    ) -> GlassButton {
        GlassButton(title, systemImage: systemImage, style: .primary, action: action)
    }

    /// Creates a secondary button with icon
    static func secondary(
        _ title: String,
        systemImage: String? = nil,
        action: @escaping () -> Void
    ) -> GlassButton {
        GlassButton(title, systemImage: systemImage, style: .secondary, action: action)
    }

    /// Creates a ghost button with icon
    static func ghost(
        _ title: String,
        systemImage: String? = nil,
        action: @escaping () -> Void
    ) -> GlassButton {
        GlassButton(title, systemImage: systemImage, style: .ghost, action: action)
    }
}

// MARK: - Previews

#Preview("Button Styles") {
    ZStack {
        AmbientBackground()

        ScrollView {
            VStack(spacing: 32) {
                VStack(spacing: 16) {
                    Text("Primary Buttons")
                        .font(.headline)
                        .foregroundStyle(Color.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    GlassButton("Start Cooking", style: .primary) {
                        print("Start cooking")
                    }

                    GlassButton("Save Recipe", systemImage: "heart.fill", style: .primary) {
                        print("Save recipe")
                    }

                    GlassButton("Begin Prep Phase", systemImage: "chef.hat", style: .primary) {
                        print("Begin prep")
                    }
                }

                VStack(spacing: 16) {
                    Text("Secondary Buttons")
                        .font(.headline)
                        .foregroundStyle(Color.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    GlassButton("View Details", style: .secondary) {
                        print("View details")
                    }

                    GlassButton("Add Note", systemImage: "note.text", style: .secondary) {
                        print("Add note")
                    }

                    GlassButton("Set Timer", systemImage: "timer", style: .secondary) {
                        print("Set timer")
                    }
                }

                VStack(spacing: 16) {
                    Text("Ghost Buttons")
                        .font(.headline)
                        .foregroundStyle(Color.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    GlassButton("Cancel", style: .ghost) {
                        print("Cancel")
                    }

                    GlassButton("Skip", systemImage: "forward", style: .ghost) {
                        print("Skip")
                    }

                    GlassButton("Learn More", systemImage: "info.circle", style: .ghost) {
                        print("Learn more")
                    }
                }
            }
            .padding()
        }
    }
}

#Preview("Interactive Demo") {
    ZStack {
        AmbientBackground()

        VStack(spacing: 24) {
            GlassCard {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Ready to Cook?")
                        .font(.title)
                        .fontWeight(.bold)
                        .foregroundStyle(Color.textPrimary)

                    Text("Start the recipe and follow along step by step")
                        .foregroundStyle(Color.textSecondary)

                    Divider()
                        .background(Color.glassBorder)

                    GlassButton.primary("Start Cooking", systemImage: "flame.fill") {
                        print("Cooking started!")
                    }

                    HStack(spacing: 12) {
                        GlassButton.secondary("Save for Later", systemImage: "bookmark") {
                            print("Saved")
                        }

                        GlassButton.ghost("Cancel", systemImage: "xmark") {
                            print("Cancelled")
                        }
                    }
                }
                .padding()
            }
            .padding()
        }
    }
}

#Preview("Button Grid") {
    ZStack {
        AmbientBackground()

        ScrollView {
            VStack(spacing: 20) {
                LazyVGrid(columns: [
                    GridItem(.flexible()),
                    GridItem(.flexible())
                ], spacing: 16) {
                    GlassButton("Cook", systemImage: "flame", style: .secondary) {}
                    GlassButton("Prep", systemImage: "leaf", style: .secondary) {}
                    GlassButton("Timer", systemImage: "timer", style: .secondary) {}
                    GlassButton("Notes", systemImage: "note", style: .secondary) {}
                    GlassButton("Share", systemImage: "square.and.arrow.up", style: .secondary) {}
                    GlassButton("Favorite", systemImage: "heart", style: .secondary) {}
                }

                GlassButton.primary("Continue to Recipe", systemImage: "arrow.right") {
                    print("Continue")
                }
            }
            .padding()
        }
    }
}

#Preview("All States") {
    ZStack {
        AmbientBackground()

        VStack(spacing: 40) {
            VStack(spacing: 12) {
                Text("Tap buttons to test haptic feedback")
                    .font(.caption)
                    .foregroundStyle(Color.textTertiary)

                GlassButton.primary("Primary Button") {
                    print("Primary tapped")
                }

                GlassButton.secondary("Secondary Button") {
                    print("Secondary tapped")
                }

                GlassButton.ghost("Ghost Button") {
                    print("Ghost tapped")
                }
            }
        }
        .padding()
    }
}
