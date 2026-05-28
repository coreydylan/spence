import Foundation
import SwiftData

@Model
final class RecipeIngredient: Codable {
    var id: UUID
    var item: String
    var quantityDisplay: String?
    var quantityVolume: String?
    var quantityWeightG: Double?
    var prep: String?
    var notes: String?
    var category: String?
    var displayOrder: Int

    var recipe: Recipe?

    init(
        id: UUID = UUID(),
        item: String,
        quantityDisplay: String? = nil,
        quantityVolume: String? = nil,
        quantityWeightG: Double? = nil,
        prep: String? = nil,
        notes: String? = nil,
        category: String? = nil,
        displayOrder: Int = 0,
        recipe: Recipe? = nil
    ) {
        self.id = id
        self.item = item
        self.quantityDisplay = quantityDisplay
        self.quantityVolume = quantityVolume
        self.quantityWeightG = quantityWeightG
        self.prep = prep
        self.notes = notes
        self.category = category
        self.displayOrder = displayOrder
        self.recipe = recipe
    }

    // MARK: - Codable

    enum CodingKeys: String, CodingKey {
        case id
        case item
        case quantityDisplay = "quantity_display"
        case quantityVolume = "quantity_volume"
        case quantityWeightG = "quantity_weight_g"
        case prep
        case notes
        case category
        case displayOrder = "display_order"
    }

    required init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        item = try container.decode(String.self, forKey: .item)
        quantityDisplay = try container.decodeIfPresent(String.self, forKey: .quantityDisplay)
        quantityVolume = try container.decodeIfPresent(String.self, forKey: .quantityVolume)
        quantityWeightG = try container.decodeIfPresent(Double.self, forKey: .quantityWeightG)
        prep = try container.decodeIfPresent(String.self, forKey: .prep)
        notes = try container.decodeIfPresent(String.self, forKey: .notes)
        category = try container.decodeIfPresent(String.self, forKey: .category)
        displayOrder = try container.decodeIfPresent(Int.self, forKey: .displayOrder) ?? 0
        recipe = nil
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        try container.encode(id, forKey: .id)
        try container.encode(item, forKey: .item)
        try container.encodeIfPresent(quantityDisplay, forKey: .quantityDisplay)
        try container.encodeIfPresent(quantityVolume, forKey: .quantityVolume)
        try container.encodeIfPresent(quantityWeightG, forKey: .quantityWeightG)
        try container.encodeIfPresent(prep, forKey: .prep)
        try container.encodeIfPresent(notes, forKey: .notes)
        try container.encodeIfPresent(category, forKey: .category)
        try container.encode(displayOrder, forKey: .displayOrder)
    }
}
