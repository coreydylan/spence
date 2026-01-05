//
//  GlassChip.swift
//  Spence
//
//  Category/filter pill component
//

import SwiftUI

/// A small pill-shaped chip for categories, filters, and tags
///
/// Features:
/// - Selected/unselected states
/// - Icon + text support
/// - Size variants (small, medium, large)
/// - Animated state transitions
/// - Haptic feedback on tap
/// - Optional close button
///
/// Usage:
/// ```swift
/// @State private var isSelected = false
///
/// GlassChip(
///     "Italian",
///     icon: "fork.knife",
///     isSelected: $isSelected
/// )
/// ```
struct GlassChip: View {
    let title: String
    let icon: String?
    @Binding var isSelected: Bool
    let size: ChipSize
    let showCloseButton: Bool
    let onTap: (() -> Void)?
    let onClose: (() -> Void)?

    /// Creates a glass chip
    ///
    /// - Parameters:
    ///   - title: Chip text
    ///   - icon: Optional SF Symbol name
    ///   - isSelected: Binding to selection state
    ///   - size: Size variant (default: .medium)
    ///   - showCloseButton: Show close button when selected (default: false)
    ///   - onTap: Optional tap handler (toggles selection by default)
    ///   - onClose: Optional close button handler
    init(
        _ title: String,
        icon: String? = nil,
        isSelected: Binding<Bool>,
        size: ChipSize = .medium,
        showCloseButton: Bool = false,
        onTap: (() -> Void)? = nil,
        onClose: (() -> Void)? = nil
    ) {
        self.title = title
        self.icon = icon
        self._isSelected = isSelected
        self.size = size
        self.showCloseButton = showCloseButton
        self.onTap = onTap
        self.onClose = onClose
    }

    var body: some View {
        Button {
            let impact = UIImpactFeedbackGenerator(style: .light)
            impact.impactOccurred()

            if let onTap {
                onTap()
            } else {
                isSelected.toggle()
            }
        } label: {
            HStack(spacing: size.iconSpacing) {
                if let icon {
                    Image(systemName: icon)
                        .font(size.iconFont)
                }

                Text(title)
                    .font(size.textFont)

                if showCloseButton && isSelected, let onClose {
                    Button {
                        let impact = UIImpactFeedbackGenerator(style: .light)
                        impact.impactOccurred()
                        onClose()
                    } label: {
                        Image(systemName: "xmark")
                            .font(size.closeButtonFont)
                    }
                }
            }
            .padding(.horizontal, size.horizontalPadding)
            .padding(.vertical, size.verticalPadding)
            .background(background)
            .overlay(border)
            .foregroundStyle(foregroundColor)
            .shadow(
                color: isSelected ? Color.spenceOrange.opacity(0.3) : Color.glassShadow.opacity(0.1),
                radius: isSelected ? 8 : 4,
                x: 0,
                y: isSelected ? 4 : 2
            )
        }
        .buttonStyle(ScaleButtonStyle())
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: isSelected)
    }

    @ViewBuilder
    private var background: some View {
        RoundedRectangle(cornerRadius: size.cornerRadius)
            .fill(.ultraThinMaterial)
            .overlay(
                RoundedRectangle(cornerRadius: size.cornerRadius)
                    .fill(
                        isSelected
                            ? Color.spenceOrange.opacity(0.25)
                            : Color.glassLight
                    )
            )
    }

    @ViewBuilder
    private var border: some View {
        RoundedRectangle(cornerRadius: size.cornerRadius)
            .strokeBorder(
                isSelected ? Color.spenceOrange : Color.glassBorder,
                lineWidth: isSelected ? 1.5 : 1
            )
    }

    private var foregroundColor: Color {
        isSelected ? Color.spenceOrange : Color.textSecondary
    }
}

// MARK: - Chip Size

enum ChipSize {
    case small
    case medium
    case large

    var textFont: Font {
        switch self {
        case .small: return .caption
        case .medium: return .subheadline
        case .large: return .body
        }
    }

    var iconFont: Font {
        switch self {
        case .small: return .caption
        case .medium: return .subheadline
        case .large: return .body
        }
    }

    var closeButtonFont: Font {
        switch self {
        case .small: return .system(size: 8)
        case .medium: return .system(size: 10)
        case .large: return .caption
        }
    }

    var horizontalPadding: CGFloat {
        switch self {
        case .small: return 10
        case .medium: return 12
        case .large: return 16
        }
    }

    var verticalPadding: CGFloat {
        switch self {
        case .small: return 6
        case .medium: return 8
        case .large: return 10
        }
    }

    var cornerRadius: CGFloat {
        switch self {
        case .small: return 12
        case .medium: return 16
        case .large: return 20
        }
    }

    var iconSpacing: CGFloat {
        switch self {
        case .small: return 4
        case .medium: return 6
        case .large: return 8
        }
    }
}

// MARK: - Scale Button Style

private struct ScaleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1.0)
            .animation(.easeInOut(duration: 0.15), value: configuration.isPressed)
    }
}

// MARK: - Static Chip Variant

/// A non-interactive chip for display purposes
struct GlassChipStatic: View {
    let title: String
    let icon: String?
    let color: Color?
    let size: ChipSize

    init(
        _ title: String,
        icon: String? = nil,
        color: Color? = nil,
        size: ChipSize = .medium
    ) {
        self.title = title
        self.icon = icon
        self.color = color
        self.size = size
    }

    var body: some View {
        HStack(spacing: size.iconSpacing) {
            if let icon {
                Image(systemName: icon)
                    .font(size.iconFont)
            }

            Text(title)
                .font(size.textFont)
        }
        .padding(.horizontal, size.horizontalPadding)
        .padding(.vertical, size.verticalPadding)
        .background(
            RoundedRectangle(cornerRadius: size.cornerRadius)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: size.cornerRadius)
                        .fill((color ?? Color.glassLight).opacity(0.3))
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: size.cornerRadius)
                .strokeBorder(color ?? Color.glassBorder, lineWidth: 1)
        )
        .foregroundStyle(color ?? Color.textSecondary)
    }
}

// MARK: - Previews

#Preview("Chip Variants") {
    @Previewable @State var selected1 = false
    @Previewable @State var selected2 = true
    @Previewable @State var selected3 = false
    @Previewable @State var selected4 = true

    ZStack {
        AmbientBackground()

        ScrollView {
            VStack(spacing: 32) {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Basic Chips")
                        .font(.headline)
                        .foregroundStyle(Color.textSecondary)

                    HStack(spacing: 12) {
                        GlassChip("Italian", isSelected: $selected1)
                        GlassChip("Quick", isSelected: $selected2)
                        GlassChip("Dinner", isSelected: $selected3)
                    }
                }

                VStack(alignment: .leading, spacing: 16) {
                    Text("With Icons")
                        .font(.headline)
                        .foregroundStyle(Color.textSecondary)

                    HStack(spacing: 12) {
                        GlassChip("Vegetarian", icon: "leaf", isSelected: $selected1)
                        GlassChip("Spicy", icon: "flame", isSelected: $selected2)
                        GlassChip("Quick", icon: "timer", isSelected: $selected3)
                    }
                }

                VStack(alignment: .leading, spacing: 16) {
                    Text("Size Variants")
                        .font(.headline)
                        .foregroundStyle(Color.textSecondary)

                    HStack(spacing: 12) {
                        GlassChip("Small", icon: "star", isSelected: $selected1, size: .small)
                        GlassChip("Medium", icon: "star", isSelected: $selected2, size: .medium)
                        GlassChip("Large", icon: "star", isSelected: $selected3, size: .large)
                    }
                }

                VStack(alignment: .leading, spacing: 16) {
                    Text("With Close Button")
                        .font(.headline)
                        .foregroundStyle(Color.textSecondary)

                    HStack(spacing: 12) {
                        GlassChip(
                            "Italian",
                            icon: "fork.knife",
                            isSelected: $selected4,
                            showCloseButton: true
                        ) {
                            print("Closed")
                        }

                        GlassChip(
                            "Spicy",
                            icon: "flame",
                            isSelected: $selected2,
                            showCloseButton: true
                        ) {
                            selected2 = false
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 16) {
                    Text("Static Chips (Non-Interactive)")
                        .font(.headline)
                        .foregroundStyle(Color.textSecondary)

                    HStack(spacing: 12) {
                        GlassChipStatic("Prep", icon: "leaf", color: .phasePrep)
                        GlassChipStatic("Cook", icon: "flame", color: .phaseCook)
                        GlassChipStatic("25 min", icon: "timer", color: .spenceOrange)
                    }
                }
            }
            .padding()
        }
    }
}

#Preview("Filter Interface") {
    @Previewable @State var selectedFilters: Set<String> = ["Quick"]

    let filters = [
        ("All", "square.grid.2x2"),
        ("Quick", "timer"),
        ("Vegetarian", "leaf"),
        ("Italian", "fork.knife"),
        ("Spicy", "flame"),
        ("Dessert", "birthday.cake")
    ]

    ZStack {
        AmbientBackground()

        VStack(spacing: 20) {
            GlassCard {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Filter Recipes")
                        .font(.title2)
                        .fontWeight(.bold)
                        .foregroundStyle(Color.textPrimary)

                    Text("Select categories to filter")
                        .font(.subheadline)
                        .foregroundStyle(Color.textSecondary)

                    Divider()
                        .background(Color.glassBorder)

                    FlowLayout(spacing: 12) {
                        ForEach(filters, id: \.0) { filter in
                            GlassChip(
                                filter.0,
                                icon: filter.1,
                                isSelected: Binding(
                                    get: { selectedFilters.contains(filter.0) },
                                    set: { isSelected in
                                        if isSelected {
                                            selectedFilters.insert(filter.0)
                                        } else {
                                            selectedFilters.remove(filter.0)
                                        }
                                    }
                                )
                            )
                        }
                    }

                    if !selectedFilters.isEmpty {
                        GlassButton.secondary("Clear All", systemImage: "xmark") {
                            selectedFilters.removeAll()
                        }
                    }
                }
                .padding()
            }
            .padding()

            Spacer()
        }
    }
}

#Preview("Recipe Tags") {
    ZStack {
        AmbientBackground()

        GlassCard {
            VStack(alignment: .leading, spacing: 16) {
                Text("Pasta Carbonara")
                    .font(.title)
                    .fontWeight(.bold)
                    .foregroundStyle(Color.textPrimary)

                HStack(spacing: 12) {
                    GlassChipStatic("25 min", icon: "timer", color: .spenceOrange)
                    GlassChipStatic("4 servings", icon: "person.2")
                    GlassChipStatic("Easy", icon: "chart.bar", color: .spenceGreen)
                }

                Divider()
                    .background(Color.glassBorder)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Categories")
                        .font(.caption)
                        .foregroundStyle(Color.textTertiary)

                    FlowLayout(spacing: 8) {
                        GlassChipStatic("Italian", icon: "fork.knife", size: .small)
                        GlassChipStatic("Dinner", icon: "moon.stars", size: .small)
                        GlassChipStatic("Quick", icon: "timer", size: .small)
                        GlassChipStatic("Pasta", icon: "sparkles", size: .small)
                    }
                }
            }
            .padding()
        }
        .padding()
    }
}

#Preview("Ingredient Categories") {
    @Previewable @State var selectedCategory = "Produce"

    let categories = [
        ("Produce", "🥬", Color.categoryProduce),
        ("Protein", "🥩", Color.categoryProtein),
        ("Dairy", "🧈", Color.categoryDairy),
        ("Pantry", "🫙", Color.categoryPantry),
        ("Spices", "🌶️", Color.categorySpices)
    ]

    ZStack {
        AmbientBackground()

        VStack(spacing: 20) {
            Text("Select Category")
                .font(.title2)
                .fontWeight(.bold)
                .foregroundStyle(Color.textPrimary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(categories, id: \.0) { category in
                        GlassChip(
                            "\(category.1) \(category.0)",
                            isSelected: Binding(
                                get: { selectedCategory == category.0 },
                                set: { if $0 { selectedCategory = category.0 } }
                            ),
                            size: .large
                        )
                    }
                }
                .padding(.horizontal)
            }

            Spacer()
        }
        .padding(.vertical)
    }
}

// MARK: - Flow Layout Helper

/// Simple flow layout for wrapping chips
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrangeRows(proposal: proposal, subviews: subviews)
        let height = rows.reduce(0) { $0 + $1.height + spacing } - spacing
        return CGSize(width: proposal.width ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = arrangeRows(proposal: proposal, subviews: subviews)
        var y = bounds.minY

        for row in rows {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(
                    at: CGPoint(x: x, y: y),
                    proposal: ProposedViewSize(size)
                )
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func arrangeRows(proposal: ProposedViewSize, subviews: Subviews) -> [(indices: [Int], height: CGFloat)] {
        var rows: [(indices: [Int], height: CGFloat)] = []
        var currentRow: [Int] = []
        var currentWidth: CGFloat = 0
        var currentHeight: CGFloat = 0
        let maxWidth = proposal.width ?? .infinity

        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)

            if currentWidth + size.width > maxWidth && !currentRow.isEmpty {
                rows.append((currentRow, currentHeight))
                currentRow = []
                currentWidth = 0
                currentHeight = 0
            }

            currentRow.append(index)
            currentWidth += size.width + spacing
            currentHeight = max(currentHeight, size.height)
        }

        if !currentRow.isEmpty {
            rows.append((currentRow, currentHeight))
        }

        return rows
    }
}
