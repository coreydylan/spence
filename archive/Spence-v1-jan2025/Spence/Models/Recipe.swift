import Foundation
import SwiftData

@Model
final class Recipe: Codable {
    // Core identifiers
    var id: UUID
    var name: String
    var source: String
    var recipeDescription: String?
    var yieldText: String

    // Timing information
    var prepMinutes: Int?
    var cookMinutes: Int?
    var totalMinutes: Int?
    var timingNotes: String?

    // Finishing information
    var finishingInstructions: String?
    var makeAhead: String?
    var storage: String?

    // User annotations
    var notes: [String]
    var isFavorite: Bool
    var isPinned: Bool
    var rating: Int?

    // Relationships
    @Relationship(deleteRule: .cascade, inverse: \RecipePhoto.recipe)
    var photos: [RecipePhoto]

    @Relationship(deleteRule: .cascade, inverse: \RecipeEquipment.recipe)
    var equipment: [RecipeEquipment]

    @Relationship(deleteRule: .cascade, inverse: \RecipeIngredient.recipe)
    var ingredients: [RecipeIngredient]

    @Relationship(deleteRule: .cascade, inverse: \PrepStep.recipe)
    var prepSteps: [PrepStep]

    @Relationship(deleteRule: .cascade, inverse: \CookStep.recipe)
    var cookSteps: [CookStep]

    @Relationship(deleteRule: .nullify, inverse: \Category.recipes)
    var categories: [Category]

    @Relationship(deleteRule: .cascade, inverse: \CookingSession.recipe)
    var cookingSessions: [CookingSession]

    // Metadata
    var createdAt: Date
    var updatedAt: Date

    init(
        id: UUID = UUID(),
        name: String,
        source: String,
        recipeDescription: String? = nil,
        yieldText: String,
        prepMinutes: Int? = nil,
        cookMinutes: Int? = nil,
        totalMinutes: Int? = nil,
        timingNotes: String? = nil,
        finishingInstructions: String? = nil,
        makeAhead: String? = nil,
        storage: String? = nil,
        notes: [String] = [],
        isFavorite: Bool = false,
        isPinned: Bool = false,
        rating: Int? = nil,
        photos: [RecipePhoto] = [],
        equipment: [RecipeEquipment] = [],
        ingredients: [RecipeIngredient] = [],
        prepSteps: [PrepStep] = [],
        cookSteps: [CookStep] = [],
        categories: [Category] = [],
        cookingSessions: [CookingSession] = [],
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.name = name
        self.source = source
        self.recipeDescription = recipeDescription
        self.yieldText = yieldText
        self.prepMinutes = prepMinutes
        self.cookMinutes = cookMinutes
        self.totalMinutes = totalMinutes
        self.timingNotes = timingNotes
        self.finishingInstructions = finishingInstructions
        self.makeAhead = makeAhead
        self.storage = storage
        self.notes = notes
        self.isFavorite = isFavorite
        self.isPinned = isPinned
        self.rating = rating
        self.photos = photos
        self.equipment = equipment
        self.ingredients = ingredients
        self.prepSteps = prepSteps
        self.cookSteps = cookSteps
        self.categories = categories
        self.cookingSessions = cookingSessions
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    // MARK: - Codable

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case source
        case recipeDescription = "description"
        case yieldText = "yield"
        case timing
        case finishing
        case notes
        case isFavorite
        case isPinned
        case rating
        case photos
        case equipment
        case ingredients
        case prepSteps = "prep_steps"
        case cookSteps = "cook_steps"
        case categories
        case createdAt
        case updatedAt
    }

    enum TimingKeys: String, CodingKey {
        case prepMinutes = "prep_minutes"
        case cookMinutes = "cook_minutes"
        case totalMinutes = "total_minutes"
        case notes
    }

    enum FinishingKeys: String, CodingKey {
        case instructions
        case makeAhead = "make_ahead"
        case storage
    }

    required init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        name = try container.decode(String.self, forKey: .name)
        source = try container.decode(String.self, forKey: .source)
        recipeDescription = try container.decodeIfPresent(String.self, forKey: .recipeDescription)
        yieldText = try container.decode(String.self, forKey: .yieldText)

        // Decode timing nested object
        if let timingContainer = try? container.nestedContainer(keyedBy: TimingKeys.self, forKey: .timing) {
            prepMinutes = try timingContainer.decodeIfPresent(Int.self, forKey: .prepMinutes)
            cookMinutes = try timingContainer.decodeIfPresent(Int.self, forKey: .cookMinutes)
            totalMinutes = try timingContainer.decodeIfPresent(Int.self, forKey: .totalMinutes)
            timingNotes = try timingContainer.decodeIfPresent(String.self, forKey: .notes)
        } else {
            prepMinutes = nil
            cookMinutes = nil
            totalMinutes = nil
            timingNotes = nil
        }

        // Decode finishing nested object
        if let finishingContainer = try? container.nestedContainer(keyedBy: FinishingKeys.self, forKey: .finishing) {
            finishingInstructions = try finishingContainer.decodeIfPresent(String.self, forKey: .instructions)
            makeAhead = try finishingContainer.decodeIfPresent(String.self, forKey: .makeAhead)
            storage = try finishingContainer.decodeIfPresent(String.self, forKey: .storage)
        } else {
            finishingInstructions = nil
            makeAhead = nil
            storage = nil
        }

        notes = try container.decodeIfPresent([String].self, forKey: .notes) ?? []
        isFavorite = try container.decodeIfPresent(Bool.self, forKey: .isFavorite) ?? false
        isPinned = try container.decodeIfPresent(Bool.self, forKey: .isPinned) ?? false
        rating = try container.decodeIfPresent(Int.self, forKey: .rating)

        photos = try container.decodeIfPresent([RecipePhoto].self, forKey: .photos) ?? []
        equipment = try container.decodeIfPresent([RecipeEquipment].self, forKey: .equipment) ?? []
        ingredients = try container.decodeIfPresent([RecipeIngredient].self, forKey: .ingredients) ?? []
        prepSteps = try container.decodeIfPresent([PrepStep].self, forKey: .prepSteps) ?? []
        cookSteps = try container.decodeIfPresent([CookStep].self, forKey: .cookSteps) ?? []
        categories = try container.decodeIfPresent([Category].self, forKey: .categories) ?? []
        cookingSessions = []

        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date()

        // Set up bidirectional relationships
        photos.forEach { $0.recipe = self }
        equipment.forEach { $0.recipe = self }
        ingredients.forEach { $0.recipe = self }
        prepSteps.forEach { $0.recipe = self }
        cookSteps.forEach { $0.recipe = self }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(source, forKey: .source)
        try container.encodeIfPresent(recipeDescription, forKey: .recipeDescription)
        try container.encode(yieldText, forKey: .yieldText)

        // Encode timing as nested object
        var timingContainer = container.nestedContainer(keyedBy: TimingKeys.self, forKey: .timing)
        try timingContainer.encodeIfPresent(prepMinutes, forKey: .prepMinutes)
        try timingContainer.encodeIfPresent(cookMinutes, forKey: .cookMinutes)
        try timingContainer.encodeIfPresent(totalMinutes, forKey: .totalMinutes)
        try timingContainer.encodeIfPresent(timingNotes, forKey: .notes)

        // Encode finishing as nested object
        var finishingContainer = container.nestedContainer(keyedBy: FinishingKeys.self, forKey: .finishing)
        try finishingContainer.encodeIfPresent(finishingInstructions, forKey: .instructions)
        try finishingContainer.encodeIfPresent(makeAhead, forKey: .makeAhead)
        try finishingContainer.encodeIfPresent(storage, forKey: .storage)

        try container.encode(notes, forKey: .notes)
        try container.encode(isFavorite, forKey: .isFavorite)
        try container.encode(isPinned, forKey: .isPinned)
        try container.encodeIfPresent(rating, forKey: .rating)

        try container.encode(photos, forKey: .photos)
        try container.encode(equipment, forKey: .equipment)
        try container.encode(ingredients, forKey: .ingredients)
        try container.encode(prepSteps, forKey: .prepSteps)
        try container.encode(cookSteps, forKey: .cookSteps)
        try container.encode(categories, forKey: .categories)

        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
    }
}

// MARK: - Preview Helper

extension Recipe {
    static var preview: Recipe {
        Recipe(
            name: "Brown Butter Tahini Cabbage",
            source: "Bon Appétit",
            recipeDescription: "Roasted cabbage wedges with nutty brown butter, tangy tahini, and bright sumac",
            yieldText: "4 servings",
            prepMinutes: 15,
            cookMinutes: 35,
            totalMinutes: 50,
            notes: ["The brown butter is key - don't rush it"]
        )
    }

    static var fullExample: Recipe {
        Recipe(
            name: "Simple Pasta",
            source: "Test Kitchen",
            yieldText: "2 servings",
            prepMinutes: 5,
            cookMinutes: 12,
            totalMinutes: 17,
            cookSteps: [
                CookStep(
                    id: 1,
                    stepNumber: 1,
                    instruction: "Bring a large pot of salted water to a rolling boil",
                    timeMinutes: 5,
                    cueVisual: "Large bubbles breaking the surface",
                    cueAudio: "Rapid bubbling sound",
                    warnings: "Be careful of steam"
                ),
                CookStep(
                    id: 2,
                    stepNumber: 2,
                    instruction: "Add pasta and stir gently",
                    timeMinutes: 8,
                    cueVisual: "Pasta moving freely in water"
                ),
                CookStep(
                    id: 3,
                    stepNumber: 3,
                    instruction: "Drain and serve",
                    cueVisual: "Al dente texture"
                )
            ]
        )
    }
}
