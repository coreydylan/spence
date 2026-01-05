//
//  AdaptiveLayout.swift
//  Spence
//
//  Responsive layout utilities for iPhone and iPad
//

import SwiftUI

// MARK: - Device Detection

enum DeviceType {
    case iPhone
    case iPad
    case mac

    static var current: DeviceType {
        #if os(iOS)
        if UIDevice.current.userInterfaceIdiom == .pad {
            return .iPad
        } else {
            return .iPhone
        }
        #elseif os(macOS)
        return .mac
        #else
        return .iPhone
        #endif
    }

    var isCompact: Bool {
        self == .iPhone
    }

    var isRegular: Bool {
        self == .iPad || self == .mac
    }
}

// MARK: - Screen Size Categories

enum ScreenSize {
    case small      // iPhone SE, Mini
    case standard   // iPhone standard
    case large      // iPhone Pro, Plus, Max
    case iPad       // iPad portrait
    case iPadWide   // iPad landscape

    static var current: ScreenSize {
        #if os(iOS)
        let width = UIScreen.main.bounds.width
        let height = UIScreen.main.bounds.height
        let isLandscape = width > height

        if UIDevice.current.userInterfaceIdiom == .pad {
            return isLandscape ? .iPadWide : .iPad
        } else {
            // iPhone sizes
            let shortEdge = min(width, height)
            if shortEdge <= 375 {
                return .small
            } else if shortEdge <= 390 {
                return .standard
            } else {
                return .large
            }
        }
        #else
        return .standard
        #endif
    }

    var columns: Int {
        switch self {
        case .small, .standard, .large:
            return 2
        case .iPad:
            return 3
        case .iPadWide:
            return 4
        }
    }
}

// MARK: - Adaptive Columns

/// Returns appropriate number of columns based on size class
struct AdaptiveColumns {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    /// Number of columns for grid layouts
    var count: Int {
        if horizontalSizeClass == .regular {
            // iPad
            if verticalSizeClass == .compact {
                // iPad landscape
                return 4
            } else {
                // iPad portrait
                return 3
            }
        } else {
            // iPhone
            if verticalSizeClass == .compact {
                // iPhone landscape
                return 3
            } else {
                // iPhone portrait
                return 2
            }
        }
    }

    /// Number of columns for recipe cards specifically
    var recipeCardColumns: Int {
        if horizontalSizeClass == .regular {
            return verticalSizeClass == .compact ? 3 : 2
        } else {
            return verticalSizeClass == .compact ? 2 : 1
        }
    }

    /// Number of columns for ingredient lists
    var ingredientColumns: Int {
        if horizontalSizeClass == .regular {
            return 2
        } else {
            return 1
        }
    }

    /// Flexible column count that can be overridden
    func columns(min: Int = 1, max: Int = 4) -> Int {
        return Swift.min(Swift.max(count, min), max)
    }
}

// MARK: - Adaptive Spacing

/// Provides size-appropriate spacing values
struct AdaptiveSpacing {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    /// Extra small spacing (4pt iPhone, 6pt iPad)
    var xs: CGFloat {
        horizontalSizeClass == .regular ? 6 : 4
    }

    /// Small spacing (8pt iPhone, 12pt iPad)
    var sm: CGFloat {
        horizontalSizeClass == .regular ? 12 : 8
    }

    /// Medium spacing (16pt iPhone, 20pt iPad)
    var md: CGFloat {
        horizontalSizeClass == .regular ? 20 : 16
    }

    /// Large spacing (24pt iPhone, 32pt iPad)
    var lg: CGFloat {
        horizontalSizeClass == .regular ? 32 : 24
    }

    /// Extra large spacing (32pt iPhone, 48pt iPad)
    var xl: CGFloat {
        horizontalSizeClass == .regular ? 48 : 32
    }

    /// Double extra large spacing (48pt iPhone, 64pt iPad)
    var xxl: CGFloat {
        horizontalSizeClass == .regular ? 64 : 48
    }

    /// Edge padding (horizontal screen margins)
    var edgePadding: CGFloat {
        horizontalSizeClass == .regular ? 32 : 20
    }

    /// Card padding (internal card spacing)
    var cardPadding: CGFloat {
        horizontalSizeClass == .regular ? 24 : 16
    }

    /// Grid spacing (between grid items)
    var gridSpacing: CGFloat {
        horizontalSizeClass == .regular ? 20 : 16
    }

    /// Section spacing (between major sections)
    var sectionSpacing: CGFloat {
        horizontalSizeClass == .regular ? 40 : 32
    }
}

// MARK: - Adaptive Sizing

/// Provides size-appropriate dimensions
struct AdaptiveSizing {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    /// Corner radius for cards
    var cardCornerRadius: CGFloat {
        horizontalSizeClass == .regular ? 28 : 24
    }

    /// Corner radius for buttons
    var buttonCornerRadius: CGFloat {
        horizontalSizeClass == .regular ? 18 : 16
    }

    /// Corner radius for small elements (badges, pills)
    var smallCornerRadius: CGFloat {
        horizontalSizeClass == .regular ? 14 : 12
    }

    /// Icon size for list items
    var iconSize: CGFloat {
        horizontalSizeClass == .regular ? 28 : 24
    }

    /// Large icon size (for empty states, headers)
    var largeIconSize: CGFloat {
        horizontalSizeClass == .regular ? 72 : 56
    }

    /// Button height
    var buttonHeight: CGFloat {
        horizontalSizeClass == .regular ? 56 : 50
    }

    /// Small button height
    var smallButtonHeight: CGFloat {
        horizontalSizeClass == .regular ? 44 : 40
    }

    /// Card minimum height
    var cardMinHeight: CGFloat {
        horizontalSizeClass == .regular ? 200 : 160
    }

    /// Cook mode card height
    var cookModeCardHeight: CGFloat {
        if horizontalSizeClass == .regular {
            return verticalSizeClass == .compact ? 400 : 500
        } else {
            return verticalSizeClass == .compact ? 280 : 380
        }
    }

    /// Timer display size
    var timerSize: CGFloat {
        horizontalSizeClass == .regular ? 200 : 160
    }
}

// MARK: - View Modifiers

struct AdaptivePadding: ViewModifier {
    let edges: Edge.Set
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    func body(content: Content) -> some View {
        content.padding(
            edges,
            horizontalSizeClass == .regular ? 32 : 20
        )
    }
}

struct AdaptiveCardPadding: ViewModifier {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    func body(content: Content) -> some View {
        content.padding(horizontalSizeClass == .regular ? 24 : 16)
    }
}

// MARK: - Convenience Extensions

extension View {
    /// Apply adaptive edge padding
    func adaptivePadding(_ edges: Edge.Set = .all) -> some View {
        modifier(AdaptivePadding(edges: edges))
    }

    /// Apply adaptive card padding
    func adaptiveCardPadding() -> some View {
        modifier(AdaptiveCardPadding())
    }
}

// MARK: - Responsive Grid Columns

/// Creates adaptive grid columns based on device
struct AdaptiveGridColumns {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    let minItemWidth: CGFloat
    let maxColumns: Int

    init(minItemWidth: CGFloat = 160, maxColumns: Int = 4) {
        self.minItemWidth = minItemWidth
        self.maxColumns = maxColumns
    }

    /// Returns array of flexible grid items
    var columns: [GridItem] {
        let count = columnCount
        return Array(repeating: GridItem(.flexible(), spacing: spacing), count: count)
    }

    /// Returns column count
    var columnCount: Int {
        if horizontalSizeClass == .regular {
            // iPad
            return verticalSizeClass == .compact ?
                min(4, maxColumns) : min(3, maxColumns)
        } else {
            // iPhone
            return verticalSizeClass == .compact ?
                min(3, maxColumns) : min(2, maxColumns)
        }
    }

    /// Returns appropriate spacing
    var spacing: CGFloat {
        horizontalSizeClass == .regular ? 20 : 16
    }

    /// Returns fixed-width columns (for precise layouts)
    func fixedColumns(itemWidth: CGFloat) -> [GridItem] {
        let count = columnCount
        return Array(repeating: GridItem(.fixed(itemWidth), spacing: spacing), count: count)
    }
}

// MARK: - Adaptive Container

/// Container that provides adaptive spacing and sizing context
struct AdaptiveContainer<Content: View>: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .frame(maxWidth: horizontalSizeClass == .regular ? 1200 : .infinity)
            .padding(.horizontal, horizontalSizeClass == .regular ? 48 : 20)
    }
}

// MARK: - Orientation Detection

struct OrientationDetector: ViewModifier {
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    let portrait: () -> Void
    let landscape: () -> Void

    func body(content: Content) -> some View {
        content
            .onChange(of: verticalSizeClass) { _, _ in
                updateOrientation()
            }
            .onChange(of: horizontalSizeClass) { _, _ in
                updateOrientation()
            }
            .onAppear {
                updateOrientation()
            }
    }

    private func updateOrientation() {
        if verticalSizeClass == .compact ||
           (horizontalSizeClass == .regular && verticalSizeClass == .compact) {
            landscape()
        } else {
            portrait()
        }
    }
}

extension View {
    /// Detect orientation changes
    func onOrientationChange(
        portrait: @escaping () -> Void,
        landscape: @escaping () -> Void
    ) -> some View {
        modifier(OrientationDetector(portrait: portrait, landscape: landscape))
    }
}

// MARK: - Safe Area Utilities

extension View {
    /// Apply adaptive safe area insets
    func adaptiveSafeAreaInset<Content: View>(
        edge: VerticalEdge,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        self.safeAreaInset(edge: edge) {
            content()
                .adaptivePadding(.horizontal)
        }
    }
}

// MARK: - Responsive Helpers

/// Helper to compute responsive values
struct ResponsiveValue<T> {
    let iPhone: T
    let iPad: T
    let iPhoneLandscape: T?
    let iPadLandscape: T?

    init(
        iPhone: T,
        iPad: T,
        iPhoneLandscape: T? = nil,
        iPadLandscape: T? = nil
    ) {
        self.iPhone = iPhone
        self.iPad = iPad
        self.iPhoneLandscape = iPhoneLandscape
        self.iPadLandscape = iPadLandscape
    }

    func value(
        horizontalSizeClass: UserInterfaceSizeClass?,
        verticalSizeClass: UserInterfaceSizeClass?
    ) -> T {
        let isLandscape = verticalSizeClass == .compact

        if horizontalSizeClass == .regular {
            // iPad
            if isLandscape, let landscape = iPadLandscape {
                return landscape
            }
            return iPad
        } else {
            // iPhone
            if isLandscape, let landscape = iPhoneLandscape {
                return landscape
            }
            return iPhone
        }
    }
}

// MARK: - Grid Layout Helpers

extension View {
    /// Apply adaptive grid layout
    func adaptiveGrid<Content: View>(
        minItemWidth: CGFloat = 160,
        maxColumns: Int = 4,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        let gridColumns = AdaptiveGridColumns(
            minItemWidth: minItemWidth,
            maxColumns: maxColumns
        )

        return LazyVGrid(columns: gridColumns.columns, spacing: gridColumns.spacing) {
            content()
        }
    }
}
