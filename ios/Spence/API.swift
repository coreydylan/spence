import Foundation

struct SpenceAPI {
    static let baseURL = "https://recipe-graph.9f745064e644311ed09914b9a12e9c7380ce62b7.workers.dev"

    static func fetchStatus() async throws -> PipelineStatus {
        let (data, _) = try await URLSession.shared.data(from: URL(string: "\(baseURL)/status")!)
        return try JSONDecoder().decode(PipelineStatus.self, from: data)
    }

    static func searchRecipes(query: String = "", limit: Int = 50) async throws -> [RecipeResult] {
        var urlStr = "\(baseURL)/recipes?limit=\(limit)"
        if !query.isEmpty {
            urlStr += "&q=\(query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query)"
        }
        let (data, _) = try await URLSession.shared.data(from: URL(string: urlStr)!)
        return try JSONDecoder().decode([RecipeResult].self, from: data)
    }

    static func fetchRecipe(id: Int) async throws -> RecipeDetail {
        let (data, _) = try await URLSession.shared.data(from: URL(string: "\(baseURL)/recipes/\(id)")!)
        return try JSONDecoder().decode(RecipeDetail.self, from: data)
    }

    static func fetchDishStream(id: Int) async throws -> CardStream {
        let (data, _) = try await URLSession.shared.data(from: URL(string: "\(baseURL)/dishes/\(id)/stream")!)
        return try JSONDecoder().decode(CardStream.self, from: data)
    }

    static func fetchCompositionTemplate(name: String) async throws -> CompositionTemplate {
        let (data, _) = try await URLSession.shared.data(from: URL(string: "\(baseURL)/compositions/\(name)/template")!)
        return try JSONDecoder().decode(CompositionTemplate.self, from: data)
    }

    static func searchDishes(query: String = "", limit: Int = 50) async throws -> [DishResult] {
        var urlStr = "\(baseURL)/dishes?limit=\(limit)"
        if !query.isEmpty {
            urlStr += "&q=\(query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query)"
        }
        let (data, _) = try await URLSession.shared.data(from: URL(string: urlStr)!)
        return try JSONDecoder().decode(DishSearchResponse.self, from: data).dishes
    }
}

struct DishSearchResponse: Decodable {
    let dishes: [DishResult]
}

struct DishResult: Decodable, Identifiable {
    let id: Int
    let canonical_title: String
    let composition: String?
    let recipe_count: Int?
    let source_count: Int?
    let consensus_total_time: Int?
    let consensus_servings: Int?
}

// MARK: - Models

struct PipelineStatus: Decodable {
    let sources: [Source]
    let total_raw_recipes: Int
    let pipeline: PipelineStep
    let canonical: CanonicalStats

    struct Source: Decodable, Identifiable {
        var id: String { name }
        let name: String
        let type: String
        let recipe_count: Int
        let last_ingested_at: String?
    }

    struct PipelineStep: Decodable {
        let parse: [String: Int]?
        let normalize: [String: Int]?
        let classify: [String: Int]?
    }

    struct CanonicalStats: Decodable {
        let ingredients: Int
        let edges: Int
    }
}

struct RecipeResult: Decodable, Identifiable {
    let id: Int
    let title: String
    let slug: String?
    let url: String?
    let source_id: Int?
    let servings: Int?
    let total_time_min: Int?
    let source_categories: String?

    var categoriesParsed: [String] {
        guard let raw = source_categories,
              let data = raw.data(using: .utf8),
              let arr = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return arr.filter { !["Recipes", "Uncategorized"].contains($0) }
    }
}

struct RecipeDetail: Decodable {
    let recipe: RawRecipe
    let parsed_ingredients: [ParsedIngredient]?
    let classification: Classification?

    struct RawRecipe: Decodable {
        let id: Int
        let title: String
        let slug: String?
        let url: String?
        let servings: Int?
        let total_time_min: Int?
        let prep_time_min: Int?
        let raw_ingredients: String?
        let raw_instructions: String?
        let source_categories: String?
        let featured_image_url: String?
    }

    struct ParsedIngredient: Decodable, Identifiable {
        var id: Int
        let raw_text: String?
        let quantity: Double?
        let unit: String?
        let name: String?
        let canonical_name: String?
        let prep: String?
    }

    struct Classification: Decodable {
        let composition: String?
        let composition_confidence: Double?
    }

    var ingredientsList: [String] {
        guard let raw = recipe.raw_ingredients,
              let data = raw.data(using: .utf8),
              let arr = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return arr
    }

    var instructionsList: [String] {
        guard let raw = recipe.raw_instructions,
              let data = raw.data(using: .utf8),
              let arr = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return arr
    }
}
