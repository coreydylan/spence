//
//  HomeView.swift
//  Spence
//
//  Main recipe browsing screen with search, categories, and recipe grid
//

import SwiftUI
import SwiftData

struct HomeView: View {
    // MARK: - Environment

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    // MARK: - State

    @State private var searchText = ""
    @State private var selectedCategory: String? = nil
    @State private var isRefreshing = false

    // MARK: - SwiftData Query
    @Query(sort: \Recipe.name) private var recipes: [Recipe]

    // MARK: - Categories (derived from recipes)
    private var categories: [String] {
        let allCategories = recipes.flatMap { $0.categories.map { $0.name } }
        return Array(Set(allCategories)).sorted()
    }

    // MARK: - Filtered Recipes

    private var filteredRecipes: [Recipe] {
        var filtered = recipes

        // Filter by category
        if let selectedCategory {
            filtered = filtered.filter { recipe in
                recipe.categories.contains { $0.name == selectedCategory }
            }
        }

        // Filter by search text
        if !searchText.isEmpty {
            filtered = filtered.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
        }

        return filtered
    }

    // MARK: - Grid Columns

    private var gridColumns: [GridItem] {
        let minWidth: CGFloat = horizontalSizeClass == .regular ? 200 : 160
        let maxWidth: CGFloat = horizontalSizeClass == .regular ? 250 : 200

        return [
            GridItem(.adaptive(minimum: minWidth, maximum: maxWidth), spacing: 16)
        ]
    }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottomTrailing) {
                // Main Content
                ScrollView {
                    LazyVStack(spacing: 20) {
                        // Search Bar
                        SearchBarView(searchText: $searchText)
                            .padding(.horizontal, 20)
                            .padding(.top, 8)

                        // Category Chips
                        CategoryChipRow(
                            selectedCategory: $selectedCategory,
                            categories: categories
                        )

                        // Recipe Grid or Empty State
                        if filteredRecipes.isEmpty {
                            emptyStateView
                        } else {
                            recipeGridView
                        }
                    }
                    .padding(.bottom, 100) // Space for floating button
                }
                .refreshable {
                    await refreshRecipes()
                }

                // Floating Add Button
                addRecipeButton
                    .padding(24)
            }
            .background {
                LinearGradient.spenceAmbient
                    .ignoresSafeArea()
            }
            .navigationTitle("Recipes")
            .navigationBarTitleDisplayMode(.large)
        }
    }

    // MARK: - Recipe Grid

    private var recipeGridView: some View {
        LazyVGrid(columns: gridColumns, spacing: 16) {
            ForEach(filteredRecipes) { recipe in
                NavigationLink {
                    RecipeDetailView(recipe: recipe)
                } label: {
                    RecipeCard(
                        recipeName: recipe.name,
                        photoURL: recipe.photos.first?.url,
                        totalMinutes: recipe.totalMinutes,
                        isFavorited: recipe.isFavorite,
                        rating: recipe.rating.map { Double($0) }
                    )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 20)
        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: filteredRecipes.count)
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: searchText.isEmpty ? "book.closed" : "magnifyingglass")
                .font(.system(size: 72))
                .foregroundStyle(Color.textTertiary)

            VStack(spacing: 8) {
                Text(searchText.isEmpty ? "No Recipes Yet" : "No Results Found")
                    .font(.spenceHeadline)
                    .foregroundStyle(Color.textPrimary)

                Text(searchText.isEmpty
                     ? "Tap the + button to add your first recipe"
                     : "Try a different search or category")
                    .font(.spenceBody)
                    .foregroundStyle(Color.textSecondary)
                    .multilineTextAlignment(.center)
            }

            if !searchText.isEmpty || selectedCategory != nil {
                Button {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
                        searchText = ""
                        selectedCategory = nil
                    }
                } label: {
                    Text("Clear Filters")
                        .font(.buttonPrimary)
                        .foregroundStyle(Color.spenceBackground)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 12)
                        .background {
                            Capsule(style: .continuous)
                                .fill(Color.spenceOrange)
                        }
                }
            }

            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 40)
    }

    // MARK: - Add Recipe Button

    private var addRecipeButton: some View {
        Button {
            // TODO: Navigate to add recipe view
            print("Add recipe tapped")
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(Color.white)
                .frame(width: 64, height: 64)
                .background {
                    Circle()
                        .fill(LinearGradient.spenceOrangeGradient)
                        .shadow(color: Color.spenceOrange.opacity(0.5), radius: 12, x: 0, y: 6)
                }
                .overlay {
                    Circle()
                        .stroke(Color.white.opacity(0.2), lineWidth: 2)
                }
        }
        .buttonStyle(.plain)
        .scaleEffect(isRefreshing ? 0.9 : 1.0)
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: isRefreshing)
    }

    // MARK: - Refresh

    private func refreshRecipes() async {
        isRefreshing = true
        // TODO: Implement actual refresh logic
        try? await Task.sleep(for: .seconds(1))
        isRefreshing = false
    }
}

// MARK: - Placeholder Detail View

private struct RecipeDetailPlaceholder: View {
    let recipeName: String

    var body: some View {
        ZStack {
            LinearGradient.spenceAmbient
                .ignoresSafeArea()

            VStack(spacing: 16) {
                Image(systemName: "fork.knife.circle.fill")
                    .font(.system(size: 80))
                    .foregroundStyle(Color.spenceOrange)

                Text("Recipe Detail")
                    .font(.spenceTitle)
                    .foregroundStyle(Color.textPrimary)

                Text(recipeName)
                    .font(.spenceHeadline)
                    .foregroundStyle(Color.textSecondary)

                Text("This view will be implemented in RecipeDetailView.swift")
                    .font(.spenceBody)
                    .foregroundStyle(Color.textTertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
            }
        }
        .navigationTitle(recipeName)
        .navigationBarTitleDisplayMode(.large)
    }
}

// MARK: - Previews

#Preview("Home with Recipes") {
    HomeView()
}

#Preview("Home - iPad") {
    HomeView()
        .environment(\.horizontalSizeClass, .regular)
}

#Preview("Home - Dark Mode") {
    HomeView()
        .preferredColorScheme(.dark)
}
