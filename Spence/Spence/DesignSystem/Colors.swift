//
//  Colors.swift
//  Spence
//
//  Warm cooking-inspired color palette with glass effects
//

import SwiftUI

extension Color {
    // MARK: - Hex Initializer

    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 3: // RGB (12-bit)
            (a, r, g, b) = (255, (int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
        case 6: // RGB (24-bit)
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8: // ARGB (32-bit)
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (1, 1, 1, 0)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: Double(a) / 255
        )
    }

    // MARK: - Backgrounds

    /// Warm charcoal base background
    static let spenceBackground = Color(hex: "1A1512")

    /// Warm brown gradient start
    static let spenceBackgroundGradientStart = Color(hex: "2D1F1A")

    /// Deep black gradient end
    static let spenceBackgroundGradientEnd = Color(hex: "0F0D0C")

    /// Alternative cooler background for variety
    static let spenceBackgroundCool = Color(hex: "12141A")

    // MARK: - Glass Surfaces

    /// Light glass overlay
    static let glassLight = Color.white.opacity(0.08)

    /// Medium glass overlay
    static let glassMedium = Color.white.opacity(0.12)

    /// Heavy glass overlay for prominent cards
    static let glassHeavy = Color.white.opacity(0.18)

    /// Glass border stroke
    static let glassBorder = Color.white.opacity(0.15)

    /// Inner glass highlight (top edge shimmer)
    static let glassHighlight = Color.white.opacity(0.25)

    /// Glass shadow color
    static let glassShadow = Color.black.opacity(0.4)

    // MARK: - Accent Colors (Warm Cooking Tones)

    /// Primary accent - vibrant cooking orange
    static let spenceOrange = Color(hex: "FF6B35")

    /// Highlight amber - for warmth and glow
    static let spenceAmber = Color(hex: "F7C548")

    /// Warning/hot - for alerts and warnings
    static let spenceRed = Color(hex: "E63946")

    /// Success/done - for completion states
    static let spenceGreen = Color(hex: "2A9D8F")

    /// Cool accent - for contrast
    static let spenceBlue = Color(hex: "4A90D9")

    // MARK: - Phase Colors

    /// CHECK phase - thoughtful purple
    static let phaseCheck = Color(hex: "7B68EE")

    /// PREP phase - active amber
    static let phasePrep = Color(hex: "F7C548")

    /// COOK phase - hot orange
    static let phaseCook = Color(hex: "FF6B35")

    // MARK: - Text Colors

    /// Primary text - nearly white
    static let textPrimary = Color.white.opacity(0.95)

    /// Secondary text - muted
    static let textSecondary = Color.white.opacity(0.65)

    /// Tertiary text - subtle
    static let textTertiary = Color.white.opacity(0.40)

    /// Disabled text
    static let textDisabled = Color.white.opacity(0.25)

    // MARK: - Semantic Colors

    /// Timer active color
    static let timerActive = Color(hex: "FF6B35")

    /// Timer warning (low time)
    static let timerWarning = Color(hex: "F7C548")

    /// Timer complete
    static let timerComplete = Color(hex: "2A9D8F")

    // MARK: - Ingredient Categories

    static let categoryProduce = Color(hex: "4CAF50")
    static let categoryProtein = Color(hex: "E57373")
    static let categoryDairy = Color(hex: "81D4FA")
    static let categoryPantry = Color(hex: "FFB74D")
    static let categorySpices = Color(hex: "CE93D8")
    static let categoryOilsVinegars = Color(hex: "A5D6A7")
}

// MARK: - Gradient Definitions

extension LinearGradient {
    /// Main ambient background gradient
    static let spenceAmbient = LinearGradient(
        colors: [
            Color.spenceBackgroundGradientStart,
            Color.spenceBackground,
            Color.spenceBackgroundGradientEnd
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    /// Glass card inner gradient (subtle depth)
    static let glassInner = LinearGradient(
        colors: [
            Color.white.opacity(0.12),
            Color.white.opacity(0.06)
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    /// Orange accent gradient
    static let spenceOrangeGradient = LinearGradient(
        colors: [
            Color.spenceAmber,
            Color.spenceOrange
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    /// Phase progress gradient
    static let phaseProgress = LinearGradient(
        colors: [
            Color.phaseCheck,
            Color.phasePrep,
            Color.phaseCook
        ],
        startPoint: .leading,
        endPoint: .trailing
    )
}

// MARK: - Radial Gradients for Ambient Effects

extension RadialGradient {
    /// Warm glow for ambient background animation
    static func warmGlow(at position: UnitPoint) -> RadialGradient {
        RadialGradient(
            colors: [
                Color.spenceOrange.opacity(0.15),
                Color.clear
            ],
            center: position,
            startRadius: 0,
            endRadius: 300
        )
    }

    /// Cool accent glow
    static func coolGlow(at position: UnitPoint) -> RadialGradient {
        RadialGradient(
            colors: [
                Color.spenceBlue.opacity(0.1),
                Color.clear
            ],
            center: position,
            startRadius: 0,
            endRadius: 250
        )
    }
}
