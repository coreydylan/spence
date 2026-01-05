import Foundation
import SwiftData

@Model
final class Category: Codable {
    var id: UUID
    var name: String
    var slug: String
    var colorHex: String?
    var iconName: String?

    var recipes: [Recipe]

    init(
        id: UUID = UUID(),
        name: String,
        slug: String,
        colorHex: String? = nil,
        iconName: String? = nil,
        recipes: [Recipe] = []
    ) {
        self.id = id
        self.name = name
        self.slug = slug
        self.colorHex = colorHex
        self.iconName = iconName
        self.recipes = recipes
    }

    // MARK: - Codable

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case slug
        case colorHex = "color_hex"
        case iconName = "icon_name"
    }

    required init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        let decodedName = try container.decode(String.self, forKey: .name)
        name = decodedName
        slug = try container.decodeIfPresent(String.self, forKey: .slug) ?? decodedName.lowercased().replacingOccurrences(of: " ", with: "-")
        colorHex = try container.decodeIfPresent(String.self, forKey: .colorHex)
        iconName = try container.decodeIfPresent(String.self, forKey: .iconName)
        recipes = []
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(slug, forKey: .slug)
        try container.encodeIfPresent(colorHex, forKey: .colorHex)
        try container.encodeIfPresent(iconName, forKey: .iconName)
    }
}
