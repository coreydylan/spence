//
//  Typography.swift
//  Spence
//
//  Typography system with kitchen-optimized sizes for Cook Mode
//

import SwiftUI

extension Font {
    // MARK: - Standard UI Typography

    /// Large titles - recipe names, screen headers
    static let spenceTitle = Font.system(size: 34, weight: .bold, design: .rounded)

    /// Section headlines
    static let spenceHeadline = Font.system(size: 24, weight: .semibold, design: .rounded)

    /// Subheadlines - card titles, phase labels
    static let spenceSubheadline = Font.system(size: 18, weight: .medium, design: .rounded)

    /// Body text - descriptions, instructions
    static let spenceBody = Font.system(size: 17, weight: .regular, design: .default)

    /// Body text medium weight
    static let spenceBodyMedium = Font.system(size: 17, weight: .medium, design: .default)

    /// Caption text - timestamps, metadata
    static let spenceCaption = Font.system(size: 14, weight: .medium, design: .rounded)

    /// Small caption - fine print
    static let spenceCaptionSmall = Font.system(size: 12, weight: .regular, design: .rounded)

    /// Footnote - very small text
    static let spenceFootnote = Font.system(size: 11, weight: .regular, design: .default)

    // MARK: - Cook Mode Typography (Extra Large for Kitchen Visibility)

    /// Cook mode step title - very readable at arm's length
    static let cookModeTitle = Font.system(size: 28, weight: .bold, design: .rounded)

    /// Cook mode instruction text - main readable body
    static let cookModeBody = Font.system(size: 22, weight: .regular, design: .default)

    /// Cook mode large body for emphasis
    static let cookModeBodyLarge = Font.system(size: 24, weight: .medium, design: .default)

    /// Cook mode timer display - large monospaced numbers
    static let cookModeTimer = Font.system(size: 64, weight: .bold, design: .monospaced)

    /// Cook mode small timer (in list)
    static let cookModeTimerSmall = Font.system(size: 32, weight: .semibold, design: .monospaced)

    /// Cook mode sensory cues
    static let cookModeCue = Font.system(size: 18, weight: .medium, design: .default)

    /// Cook mode step number indicator
    static let cookModeStepNumber = Font.system(size: 16, weight: .bold, design: .rounded)

    // MARK: - Ingredient & Step Typography

    /// Ingredient item name
    static let ingredientName = Font.system(size: 17, weight: .medium, design: .default)

    /// Ingredient quantity
    static let ingredientQuantity = Font.system(size: 15, weight: .regular, design: .default)

    /// Step number badge
    static let stepNumber = Font.system(size: 14, weight: .bold, design: .rounded)

    /// Step instruction text
    static let stepInstruction = Font.system(size: 16, weight: .regular, design: .default)

    /// Time estimate badge
    static let timeBadge = Font.system(size: 13, weight: .semibold, design: .rounded)

    // MARK: - Button Typography

    /// Primary button text
    static let buttonPrimary = Font.system(size: 17, weight: .semibold, design: .rounded)

    /// Secondary button text
    static let buttonSecondary = Font.system(size: 15, weight: .medium, design: .rounded)

    /// Small button/link text
    static let buttonSmall = Font.system(size: 14, weight: .medium, design: .rounded)
}

// MARK: - Text Styles

extension View {
    /// Apply primary text styling
    func textPrimary() -> some View {
        self.foregroundStyle(Color.textPrimary)
    }

    /// Apply secondary text styling
    func textSecondary() -> some View {
        self.foregroundStyle(Color.textSecondary)
    }

    /// Apply tertiary text styling
    func textTertiary() -> some View {
        self.foregroundStyle(Color.textTertiary)
    }
}

// MARK: - Adaptive Typography

struct AdaptiveFont: ViewModifier {
    @Environment(\.horizontalSizeClass) var horizontalSizeClass
    let compactFont: Font
    let regularFont: Font

    func body(content: Content) -> some View {
        content
            .font(horizontalSizeClass == .compact ? compactFont : regularFont)
    }
}

extension View {
    /// Apply font that adapts to size class (iPhone vs iPad)
    func adaptiveFont(compact: Font, regular: Font) -> some View {
        modifier(AdaptiveFont(compactFont: compact, regularFont: regular))
    }
}

// MARK: - Dynamic Type Support

struct ScaledFont: ViewModifier {
    @Environment(\.dynamicTypeSize) var dynamicTypeSize
    let baseFont: Font
    let maxSize: DynamicTypeSize

    func body(content: Content) -> some View {
        content
            .font(baseFont)
            .dynamicTypeSize(...maxSize)
    }
}

extension View {
    /// Apply font with maximum dynamic type size (for layout-sensitive areas)
    func scaledFont(_ font: Font, maxSize: DynamicTypeSize = .accessibility2) -> some View {
        modifier(ScaledFont(baseFont: font, maxSize: maxSize))
    }
}
