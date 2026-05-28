//
//  CategoryChipRow.swift
//  Spence
//
//  Horizontal scrolling category filter chips
//

import SwiftUI

struct CategoryChipRow: View {
    @Binding var selectedCategory: String?
    let categories: [String]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                // "All" chip
                CategoryChip(
                    title: "All",
                    isSelected: selectedCategory == nil
                ) {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
                        selectedCategory = nil
                    }
                }

                // Individual category chips
                ForEach(categories, id: \.self) { category in
                    CategoryChip(
                        title: category,
                        isSelected: selectedCategory == category
                    ) {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
                            selectedCategory = category
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 8)
        }
        .scrollClipDisabled()
    }
}

// MARK: - Category Chip

private struct CategoryChip: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    @State private var isPressed = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.spenceCaption)
                .fontWeight(isSelected ? .semibold : .medium)
                .foregroundStyle(isSelected ? Color.spenceBackground : Color.textPrimary)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background {
                    Capsule(style: .continuous)
                        .fill(isSelected ? Color.spenceOrange : Color.glassMedium)
                        .overlay {
                            if !isSelected {
                                Capsule(style: .continuous)
                                    .stroke(Color.glassBorder, lineWidth: 1)
                            }
                        }
                }
                .scaleEffect(isPressed ? 0.95 : 1.0)
                .shadow(
                    color: isSelected ? Color.spenceOrange.opacity(0.4) : Color.glassShadow,
                    radius: isSelected ? 8 : 4,
                    x: 0,
                    y: 2
                )
        }
        .buttonStyle(.plain)
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    withAnimation(.easeInOut(duration: 0.1)) {
                        isPressed = true
                    }
                }
                .onEnded { _ in
                    withAnimation(.easeInOut(duration: 0.1)) {
                        isPressed = false
                    }
                }
        )
    }
}

#Preview("Multiple Categories") {
    ZStack {
        Color.spenceBackground.ignoresSafeArea()

        VStack {
            CategoryChipRow(
                selectedCategory: .constant(nil),
                categories: ["Italian", "Mexican", "Asian", "Mediterranean", "American", "French"]
            )

            Spacer()
        }
    }
}

#Preview("Selected Category") {
    ZStack {
        Color.spenceBackground.ignoresSafeArea()

        VStack {
            CategoryChipRow(
                selectedCategory: .constant("Italian"),
                categories: ["Italian", "Mexican", "Asian", "Mediterranean"]
            )

            Spacer()
        }
    }
}

#Preview("Long Category Names") {
    ZStack {
        Color.spenceBackground.ignoresSafeArea()

        VStack {
            CategoryChipRow(
                selectedCategory: .constant("Southern Comfort"),
                categories: ["Traditional Italian", "Mexican Street Food", "Pan-Asian Fusion", "Southern Comfort"]
            )

            Spacer()
        }
    }
}
