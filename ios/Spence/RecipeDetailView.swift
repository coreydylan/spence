import SwiftUI

struct RecipeDetailView: View {
    let recipeId: Int
    @State private var detail: RecipeDetail?
    @State private var isLoading = true

    var body: some View {
        ZStack {
            if isLoading {
                ProgressView()
            } else if let detail {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // Header
                        VStack(alignment: .leading, spacing: 8) {
                            Text(detail.recipe.title)
                                .font(.title2.bold())

                            HStack(spacing: 16) {
                                if let time = detail.recipe.total_time_min, time > 0 {
                                    Label("\(time) min", systemImage: "clock")
                                }
                                if let servings = detail.recipe.servings, servings > 0 {
                                    Label("Serves \(servings)", systemImage: "person.2")
                                }
                                if let prep = detail.recipe.prep_time_min, prep > 0 {
                                    Label("\(prep) min prep", systemImage: "knife")
                                }
                            }
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                            if let url = detail.recipe.url {
                                Link("View original", destination: URL(string: url)!)
                                    .font(.caption)
                            }
                        }

                        Divider()

                        // Ingredients
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Ingredients")
                                .font(.headline)

                            ForEach(Array(detail.ingredientsList.enumerated()), id: \.offset) { _, ingredient in
                                HStack(alignment: .top, spacing: 8) {
                                    Circle()
                                        .fill(.primary.opacity(0.2))
                                        .frame(width: 6, height: 6)
                                        .padding(.top, 6)
                                    Text(ingredient)
                                        .font(.body)
                                }
                            }
                        }

                        Divider()

                        // Steps
                        VStack(alignment: .leading, spacing: 16) {
                            Text("Steps")
                                .font(.headline)

                            ForEach(Array(detail.instructionsList.enumerated()), id: \.offset) { index, step in
                                HStack(alignment: .top, spacing: 12) {
                                    Text("\(index + 1)")
                                        .font(.system(.callout, design: .rounded, weight: .bold))
                                        .foregroundStyle(.white)
                                        .frame(width: 28, height: 28)
                                        .background(Circle().fill(.blue))

                                    Text(step)
                                        .font(.body)
                                }
                            }
                        }
                    }
                    .padding()
                }
            } else {
                ContentUnavailableView("Recipe not found", systemImage: "fork.knife")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            isLoading = true
            detail = try? await SpenceAPI.fetchRecipe(id: recipeId)
            isLoading = false
        }
    }
}
