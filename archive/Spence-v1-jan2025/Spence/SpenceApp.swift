//
//  SpenceApp.swift
//  Spence
//
//  A beautiful frosted glass recipe app that teaches home cooks to cook like pros.
//

import SwiftUI
import SwiftData

@main
struct SpenceApp: App {
    var sharedModelContainer: ModelContainer = {
        let schema = Schema([
            Recipe.self,
            RecipePhoto.self,
            RecipeEquipment.self,
            RecipeIngredient.self,
            PrepStep.self,
            CookStep.self,
            Category.self,
            UserProfile.self,
            CookingSession.self
        ])
        let modelConfiguration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)

        do {
            return try ModelContainer(for: schema, configurations: [modelConfiguration])
        } catch {
            fatalError("Could not create ModelContainer: \(error)")
        }
    }()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark) // Always dark mode for glass effects
                .onAppear {
                    // Seed demo recipes on first launch
                    let context = sharedModelContainer.mainContext
                    DataSeeder.seedDemoRecipesIfNeeded(modelContext: context)
                }
        }
        .modelContainer(sharedModelContainer)
    }
}
