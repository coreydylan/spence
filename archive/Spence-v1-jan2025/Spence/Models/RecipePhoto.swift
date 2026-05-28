import Foundation
import SwiftData

@Model
final class RecipePhoto: Codable {
    var id: UUID
    var storagePath: String
    var displayOrder: Int
    var isPrimary: Bool
    var caption: String?

    var recipe: Recipe?

    /// Computed URL from storage path
    var url: URL? {
        URL(string: storagePath)
    }

    init(
        id: UUID = UUID(),
        storagePath: String,
        displayOrder: Int = 0,
        isPrimary: Bool = false,
        caption: String? = nil,
        recipe: Recipe? = nil
    ) {
        self.id = id
        self.storagePath = storagePath
        self.displayOrder = displayOrder
        self.isPrimary = isPrimary
        self.caption = caption
        self.recipe = recipe
    }

    // MARK: - Codable

    enum CodingKeys: String, CodingKey {
        case id
        case storagePath = "storage_path"
        case displayOrder = "display_order"
        case isPrimary = "is_primary"
        case caption
    }

    required init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        storagePath = try container.decode(String.self, forKey: .storagePath)
        displayOrder = try container.decodeIfPresent(Int.self, forKey: .displayOrder) ?? 0
        isPrimary = try container.decodeIfPresent(Bool.self, forKey: .isPrimary) ?? false
        caption = try container.decodeIfPresent(String.self, forKey: .caption)
        recipe = nil
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        try container.encode(id, forKey: .id)
        try container.encode(storagePath, forKey: .storagePath)
        try container.encode(displayOrder, forKey: .displayOrder)
        try container.encode(isPrimary, forKey: .isPrimary)
        try container.encodeIfPresent(caption, forKey: .caption)
    }
}
