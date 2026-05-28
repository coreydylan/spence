//
//  DataSeeder.swift
//  Spence
//
//  Seeds demo recipes into SwiftData on first launch
//

import Foundation
import SwiftData

@MainActor
class DataSeeder {

    private static let hasSeededKey = "hasSeededDemoRecipes"

    /// Check if demo recipes have already been seeded
    static var hasSeeded: Bool {
        UserDefaults.standard.bool(forKey: hasSeededKey)
    }

    /// Seed demo recipes from bundled JSON files
    static func seedDemoRecipesIfNeeded(modelContext: ModelContext) {
        guard !hasSeeded else {
            print("Demo recipes already seeded, skipping...")
            return
        }

        print("Seeding demo recipes...")

        // Load all JSON files from the recipes directory in the bundle
        guard let recipesURL = Bundle.main.resourceURL?.appendingPathComponent("recipes") else {
            print("Could not find recipes directory in bundle")
            // Try alternative: look for JSON files directly in bundle
            seedFromFlatBundle(modelContext: modelContext)
            return
        }

        do {
            let fileManager = FileManager.default
            let jsonFiles = try fileManager.contentsOfDirectory(at: recipesURL, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "json" }

            if jsonFiles.isEmpty {
                print("No JSON files found in recipes directory")
                seedFromFlatBundle(modelContext: modelContext)
                return
            }

            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase

            var seededCount = 0
            for fileURL in jsonFiles {
                do {
                    let data = try Data(contentsOf: fileURL)
                    let recipeJSON = try decoder.decode(RecipeJSON.self, from: data)
                    let recipe = recipeJSON.toRecipe()
                    modelContext.insert(recipe)
                    seededCount += 1
                    print("Seeded: \(recipe.name)")
                } catch {
                    print("Failed to load \(fileURL.lastPathComponent): \(error)")
                }
            }

            if seededCount > 0 {
                try? modelContext.save()
                UserDefaults.standard.set(true, forKey: hasSeededKey)
                print("Successfully seeded \(seededCount) demo recipes")
            }
        } catch {
            print("Error reading recipes directory: \(error)")
            seedFromFlatBundle(modelContext: modelContext)
        }
    }

    /// Alternative: Look for JSON files directly in the bundle root
    private static func seedFromFlatBundle(modelContext: ModelContext) {
        guard let urls = Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: nil) else {
            print("No JSON files found in bundle")
            return
        }

        let recipeFiles = urls.filter { url in
            // Only process files that look like recipe files
            let filename = url.lastPathComponent
            return filename.contains("cabbage") ||
                   filename.contains("chili") ||
                   filename.contains("waffle") ||
                   filename.contains("pita") ||
                   filename.contains("potato") ||
                   filename.contains("chia") ||
                   filename.contains("hummus") ||
                   filename.contains("burrata") ||
                   filename.contains("falafel") ||
                   filename.hasPrefix("01-") ||
                   filename.hasPrefix("02-") ||
                   filename.hasPrefix("03-")
        }

        if recipeFiles.isEmpty {
            print("No recipe JSON files found in bundle")
            return
        }

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        var seededCount = 0
        for fileURL in recipeFiles {
            do {
                let data = try Data(contentsOf: fileURL)
                let recipeJSON = try decoder.decode(RecipeJSON.self, from: data)
                let recipe = recipeJSON.toRecipe()
                modelContext.insert(recipe)
                seededCount += 1
                print("Seeded: \(recipe.name)")
            } catch {
                print("Failed to load \(fileURL.lastPathComponent): \(error)")
            }
        }

        if seededCount > 0 {
            try? modelContext.save()
            UserDefaults.standard.set(true, forKey: hasSeededKey)
            print("Successfully seeded \(seededCount) demo recipes from flat bundle")
        }
    }

    /// Reset seeding state (for testing)
    static func resetSeedingState() {
        UserDefaults.standard.removeObject(forKey: hasSeededKey)
    }
}
