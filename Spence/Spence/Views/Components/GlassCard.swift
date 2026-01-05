//
//  GlassCard.swift
//  Spence
//
//  Reusable frosted glass card component
//

import SwiftUI

/// A reusable frosted glass card with configurable styling
///
/// Features:
/// - Ultra-thin material blur effect
/// - Configurable corner radius
/// - White overlay with adjustable opacity
/// - Border stroke and shadow
/// - Accepts any content via ViewBuilder
///
/// Usage:
/// ```swift
/// GlassCard {
///     VStack {
///         Text("Title")
///         Text("Content")
///     }
///     .padding()
/// }
/// ```
struct GlassCard<Content: View>: View {
    let content: Content
    let cornerRadius: CGFloat
    let glassOpacity: Double
    let borderWidth: CGFloat
    let shadowRadius: CGFloat

    /// Creates a glass card with custom content
    ///
    /// - Parameters:
    ///   - cornerRadius: Corner radius of the card (default: 24)
    ///   - glassOpacity: Opacity of the white glass overlay (default: 0.12)
    ///   - borderWidth: Width of the border stroke (default: 1)
    ///   - shadowRadius: Blur radius of the shadow (default: 20)
    ///   - content: The view content to display inside the card
    init(
        cornerRadius: CGFloat = 24,
        glassOpacity: Double = 0.12,
        borderWidth: CGFloat = 1,
        shadowRadius: CGFloat = 20,
        @ViewBuilder content: () -> Content
    ) {
        self.cornerRadius = cornerRadius
        self.glassOpacity = glassOpacity
        self.borderWidth = borderWidth
        self.shadowRadius = shadowRadius
        self.content = content()
    }

    var body: some View {
        content
            .background(
                ZStack {
                    // Frosted glass effect
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .fill(.ultraThinMaterial)

                    // White overlay for glass effect
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .fill(Color.white.opacity(glassOpacity))

                    // Subtle top highlight for depth
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.glassHighlight,
                                    Color.clear
                                ],
                                startPoint: .top,
                                endPoint: .center
                            )
                        )
                }
            )
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(Color.glassBorder, lineWidth: borderWidth)
            )
            .shadow(color: Color.glassShadow, radius: shadowRadius, x: 0, y: 10)
    }
}

// MARK: - Convenience Initializers

extension GlassCard {
    /// Creates a light glass card with reduced opacity
    static func light(@ViewBuilder content: () -> Content) -> GlassCard {
        GlassCard(glassOpacity: 0.08, content: content)
    }

    /// Creates a medium glass card (default)
    static func medium(@ViewBuilder content: () -> Content) -> GlassCard {
        GlassCard(glassOpacity: 0.12, content: content)
    }

    /// Creates a heavy glass card with increased opacity
    static func heavy(@ViewBuilder content: () -> Content) -> GlassCard {
        GlassCard(glassOpacity: 0.18, content: content)
    }

    /// Creates a compact glass card with smaller corner radius
    static func compact(@ViewBuilder content: () -> Content) -> GlassCard {
        GlassCard(cornerRadius: 16, content: content)
    }

    /// Creates a large glass card with bigger corner radius
    static func large(@ViewBuilder content: () -> Content) -> GlassCard {
        GlassCard(cornerRadius: 32, content: content)
    }
}

// MARK: - Previews

#Preview("Glass Card Variants") {
    ZStack {
        AmbientBackground()

        ScrollView {
            VStack(spacing: 24) {
                // Light card
                GlassCard.light {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Light Glass")
                            .font(.headline)
                            .foregroundStyle(Color.textPrimary)
                        Text("Subtle, minimal opacity")
                            .font(.subheadline)
                            .foregroundStyle(Color.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }

                // Medium card (default)
                GlassCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Medium Glass")
                            .font(.headline)
                            .foregroundStyle(Color.textPrimary)
                        Text("Balanced visibility and frosting")
                            .font(.subheadline)
                            .foregroundStyle(Color.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }

                // Heavy card
                GlassCard.heavy {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Heavy Glass")
                            .font(.headline)
                            .foregroundStyle(Color.textPrimary)
                        Text("More prominent, higher opacity")
                            .font(.subheadline)
                            .foregroundStyle(Color.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }

                // Compact card
                GlassCard.compact {
                    HStack(spacing: 12) {
                        Image(systemName: "flame.fill")
                            .foregroundStyle(Color.spenceOrange)
                        Text("Compact Card")
                            .foregroundStyle(Color.textPrimary)
                    }
                    .padding()
                }

                // Large card
                GlassCard.large {
                    VStack(spacing: 16) {
                        Image(systemName: "fork.knife")
                            .font(.system(size: 48))
                            .foregroundStyle(Color.spenceAmber)
                        Text("Large Glass Card")
                            .font(.title2)
                            .foregroundStyle(Color.textPrimary)
                        Text("Perfect for hero content")
                            .foregroundStyle(Color.textSecondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(32)
                }
            }
            .padding()
        }
    }
}

#Preview("Recipe Card Example") {
    ZStack {
        AmbientBackground()

        VStack {
            GlassCard {
                VStack(alignment: .leading, spacing: 16) {
                    // Header
                    HStack {
                        VStack(alignment: .leading) {
                            Text("Pasta Carbonara")
                                .font(.title2)
                                .fontWeight(.bold)
                                .foregroundStyle(Color.textPrimary)
                            Text("Italian Classic")
                                .font(.subheadline)
                                .foregroundStyle(Color.textSecondary)
                        }
                        Spacer()
                        Image(systemName: "heart.fill")
                            .foregroundStyle(Color.spenceOrange)
                    }

                    Divider()
                        .background(Color.glassBorder)

                    // Details
                    HStack(spacing: 24) {
                        Label("25 min", systemImage: "clock")
                        Label("4 servings", systemImage: "person.2")
                        Label("Easy", systemImage: "chart.bar")
                    }
                    .font(.caption)
                    .foregroundStyle(Color.textSecondary)

                    // Tags
                    HStack(spacing: 8) {
                        ForEach(["Dinner", "Quick", "Italian"], id: \.self) { tag in
                            Text(tag)
                                .font(.caption)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(Color.glassLight)
                                .cornerRadius(8)
                                .foregroundStyle(Color.textSecondary)
                        }
                    }
                }
                .padding()
            }
            .padding()
        }
    }
}

#Preview("Custom Styling") {
    ZStack {
        AmbientBackground()

        VStack(spacing: 20) {
            GlassCard(
                cornerRadius: 12,
                glassOpacity: 0.2,
                borderWidth: 2,
                shadowRadius: 30
            ) {
                Text("Custom Corner Radius & Opacity")
                    .foregroundStyle(Color.textPrimary)
                    .padding()
            }

            GlassCard(
                cornerRadius: 40,
                glassOpacity: 0.05,
                borderWidth: 0.5,
                shadowRadius: 10
            ) {
                Text("Extra Rounded & Subtle")
                    .foregroundStyle(Color.textPrimary)
                    .padding()
            }
        }
        .padding()
    }
}
