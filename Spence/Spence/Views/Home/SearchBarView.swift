//
//  SearchBarView.swift
//  Spence
//
//  Glass search pill for recipe browsing
//

import SwiftUI

struct SearchBarView: View {
    @Binding var searchText: String
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "magnifyingglass")
                .font(.spenceBody)
                .foregroundStyle(Color.textSecondary)

            TextField("Search recipes...", text: $searchText)
                .font(.spenceBody)
                .foregroundStyle(Color.textPrimary)
                .focused($isFocused)
                .submitLabel(.search)

            if !searchText.isEmpty {
                Button {
                    searchText = ""
                    isFocused = false
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.spenceBody)
                        .foregroundStyle(Color.textSecondary)
                }
                .transition(.scale.combined(with: .opacity))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(Color.glassMedium)
                .overlay {
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .stroke(Color.glassBorder, lineWidth: 1)
                }
                .shadow(color: Color.glassShadow, radius: 8, x: 0, y: 4)
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: searchText.isEmpty)
    }
}

#Preview("Empty") {
    ZStack {
        Color.spenceBackground.ignoresSafeArea()

        SearchBarView(searchText: .constant(""))
            .padding()
    }
}

#Preview("With Text") {
    ZStack {
        Color.spenceBackground.ignoresSafeArea()

        SearchBarView(searchText: .constant("pasta"))
            .padding()
    }
}

#Preview("Long Text") {
    ZStack {
        Color.spenceBackground.ignoresSafeArea()

        SearchBarView(searchText: .constant("carbonara with pancetta"))
            .padding()
    }
}
