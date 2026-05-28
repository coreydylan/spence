import Foundation
import SwiftData

@Model
final class RecipeEquipment: Codable {
    var id: UUID
    var item: String
    var required: Bool
    var alternative: String?
    var notes: String?
    var displayOrder: Int

    var recipe: Recipe?

    init(
        id: UUID = UUID(),
        item: String,
        required: Bool = true,
        alternative: String? = nil,
        notes: String? = nil,
        displayOrder: Int = 0,
        recipe: Recipe? = nil
    ) {
        self.id = id
        self.item = item
        self.required = required
        self.alternative = alternative
        self.notes = notes
        self.displayOrder = displayOrder
        self.recipe = recipe
    }

    // MARK: - Codable

    enum CodingKeys: String, CodingKey {
        case id
        case item
        case required
        case alternative
        case notes
        case displayOrder = "display_order"
    }

    required init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        item = try container.decode(String.self, forKey: .item)
        required = try container.decodeIfPresent(Bool.self, forKey: .required) ?? true
        alternative = try container.decodeIfPresent(String.self, forKey: .alternative)
        notes = try container.decodeIfPresent(String.self, forKey: .notes)
        displayOrder = try container.decodeIfPresent(Int.self, forKey: .displayOrder) ?? 0
        recipe = nil
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        try container.encode(id, forKey: .id)
        try container.encode(item, forKey: .item)
        try container.encode(required, forKey: .required)
        try container.encodeIfPresent(alternative, forKey: .alternative)
        try container.encodeIfPresent(notes, forKey: .notes)
        try container.encode(displayOrder, forKey: .displayOrder)
    }
}
