//
//  JSONLoader.swift
//  Spence
//
//  Utility for loading test recipes from JSON files
//

import Foundation

enum JSONLoaderError: Error {
    case fileNotFound
    case decodingFailed(Error)
}

struct JSONLoader {

    /// Load a single recipe from a JSON file in the bundle
    static func loadRecipe(named filename: String) throws -> RecipeJSON {
        guard let url = Bundle.main.url(forResource: filename, withExtension: "json") else {
            throw JSONLoaderError.fileNotFound
        }

        do {
            let data = try Data(contentsOf: url)
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            return try decoder.decode(RecipeJSON.self, from: data)
        } catch {
            throw JSONLoaderError.decodingFailed(error)
        }
    }

    /// Load all recipes from a directory
    static func loadAllRecipes(from directory: String = "recipes") throws -> [RecipeJSON] {
        guard let urls = Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: directory) else {
            return []
        }

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        return urls.compactMap { url in
            do {
                let data = try Data(contentsOf: url)
                return try decoder.decode(RecipeJSON.self, from: data)
            } catch {
                print("Failed to decode \(url.lastPathComponent): \(error)")
                return nil
            }
        }
    }

    /// Load recipe from raw JSON data (for testing or API responses)
    static func loadRecipe(from data: Data) throws -> RecipeJSON {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(RecipeJSON.self, from: data)
    }
}

// MARK: - JSON Structures (matches normalized recipe format)

struct RecipeJSON: Codable {
    let name: String
    let source: String?
    let description: String?
    let yield: String?
    let timing: TimingJSON?
    let equipment: [EquipmentJSON]?
    let ingredients: [IngredientJSON]?
    let prepSteps: [PrepStepJSON]?
    let cookSteps: [CookStepJSON]?
    let finishing: FinishingJSON?
    let notes: [String]?
}

struct TimingJSON: Codable {
    let prepMinutes: Int?
    let cookMinutes: Int?
    let totalMinutes: Int?
    let notes: String?
}

struct EquipmentJSON: Codable {
    let item: String
    let required: Bool?
    let alternative: String?
    let notes: String?
}

struct IngredientJSON: Codable {
    let item: String
    let quantityDisplay: String?
    let quantityVolume: String?
    let quantityWeightG: Double?
    let prep: String?
    let notes: String?
    let category: String?
}

struct PrepStepJSON: Codable {
    let id: Int
    let instruction: String
    let outputs: [String]?
    let container: String?
    let station: String?
    let timeMinutes: Double?
    let notes: String?
}

struct CookStepJSON: Codable {
    let id: Int
    let instruction: String
    let timeMinutes: Double?
    let dependsOn: [Int]?
    let usesOutputs: [String]?
    let cues: CuesJSON?
    let warnings: String?
}

struct CuesJSON: Codable {
    let visual: String?
    let audio: String?
    let aroma: String?
}

struct FinishingJSON: Codable {
    let instructions: String?
    let makeAhead: String?
    let storage: String?
}

// MARK: - Conversion to SwiftData Models

extension RecipeJSON {
    func toRecipe() -> Recipe {
        let recipe = Recipe(
            name: name,
            source: source ?? "Unknown",
            recipeDescription: description,
            yieldText: yield ?? "1 serving",
            prepMinutes: timing?.prepMinutes,
            cookMinutes: timing?.cookMinutes,
            totalMinutes: timing?.totalMinutes,
            timingNotes: timing?.notes,
            finishingInstructions: finishing?.instructions,
            makeAhead: finishing?.makeAhead,
            storage: finishing?.storage,
            notes: notes ?? []
        )

        // Add equipment
        recipe.equipment = equipment?.enumerated().map { index, eq in
            RecipeEquipment(
                item: eq.item,
                required: eq.required ?? true,
                alternative: eq.alternative,
                notes: eq.notes,
                displayOrder: index
            )
        } ?? []

        // Add ingredients
        recipe.ingredients = ingredients?.enumerated().map { index, ing in
            RecipeIngredient(
                item: ing.item,
                quantityDisplay: ing.quantityDisplay,
                quantityVolume: ing.quantityVolume,
                quantityWeightG: ing.quantityWeightG,
                prep: ing.prep,
                notes: ing.notes,
                category: ing.category,
                displayOrder: index
            )
        } ?? []

        // Add prep steps
        recipe.prepSteps = prepSteps?.map { step in
            PrepStep(
                id: step.id,
                stepNumber: step.id,
                instruction: step.instruction,
                outputs: step.outputs ?? [],
                container: step.container,
                station: step.station,
                timeMinutes: step.timeMinutes,
                notes: step.notes
            )
        } ?? []

        // Add cook steps
        recipe.cookSteps = cookSteps?.map { step in
            CookStep(
                id: step.id,
                stepNumber: step.id,
                instruction: step.instruction,
                timeMinutes: step.timeMinutes,
                dependsOn: step.dependsOn ?? [],
                usesOutputs: step.usesOutputs ?? [],
                cueVisual: step.cues?.visual,
                cueAudio: step.cues?.audio,
                cueAroma: step.cues?.aroma,
                warnings: step.warnings
            )
        } ?? []

        return recipe
    }
}
