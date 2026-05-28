import Foundation

// MARK: - Card Stream

struct CardStream: Decodable {
    let recipe_id: Int
    let canonical_title: String
    let stream: [Card]
}

// MARK: - Card

enum CardLock: String, Decodable {
    case inferred
    case userSet = "user_set"
    case locked
    case unknown

    init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
        self = CardLock(rawValue: raw) ?? .unknown
    }
}

struct Card: Identifiable, Decodable {
    let id: String
    let type: String
    let lock: CardLock
    let source: String?
    let binding: String?
    let content: CardContent

    enum CodingKeys: String, CodingKey {
        case id, type, lock, source, binding, content
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.type = try c.decode(String.self, forKey: .type)
        self.lock = (try? c.decode(CardLock.self, forKey: .lock)) ?? .unknown
        self.source = try? c.decode(String.self, forKey: .source)
        self.binding = try? c.decode(String.self, forKey: .binding)

        // Decode content based on type
        let contentDecoder = try c.superDecoder(forKey: .content)
        self.content = CardContent.decode(type: self.type, from: contentDecoder)
    }

    var isInferred: Bool { lock == .inferred }
}

// MARK: - Card Content

enum CardContent {
    case title(TitleContent)
    case canonicalBadge(BadgeContent)
    case tagChips(TagChipsContent)
    case time(TimeContent)
    case yield(YieldContent)
    case ingredientGroup(IngredientGroupContent)
    case ingredient(IngredientContent)
    case optionalIngredients(OptionalIngredientsContent)
    case variationChips(VariationChipsContent)
    case equipment(EquipmentContent)
    case compositionHeader(CompositionHeaderContent)
    case variantSetCarousel(VariantSetCarouselContent)
    case slot(SlotContent)
    case multiSlot(MultiSlotContent)
    case unknown(type: String)

    static func decode(type: String, from decoder: Decoder) -> CardContent {
        switch type {
        case "title":
            if let v = try? TitleContent(from: decoder) { return .title(v) }
        case "canonical_badge":
            if let v = try? BadgeContent(from: decoder) { return .canonicalBadge(v) }
        case "tag_chips":
            if let v = try? TagChipsContent(from: decoder) { return .tagChips(v) }
        case "time":
            if let v = try? TimeContent(from: decoder) { return .time(v) }
        case "yield":
            if let v = try? YieldContent(from: decoder) { return .yield(v) }
        case "ingredient_group":
            if let v = try? IngredientGroupContent(from: decoder) { return .ingredientGroup(v) }
        case "ingredient":
            if let v = try? IngredientContent(from: decoder) { return .ingredient(v) }
        case "optional_ingredients":
            if let v = try? OptionalIngredientsContent(from: decoder) { return .optionalIngredients(v) }
        case "variation_chips":
            if let v = try? VariationChipsContent(from: decoder) { return .variationChips(v) }
        case "equipment":
            if let v = try? EquipmentContent(from: decoder) { return .equipment(v) }
        case "composition_header":
            if let v = try? CompositionHeaderContent(from: decoder) { return .compositionHeader(v) }
        case "variant_set_carousel":
            if let v = try? VariantSetCarouselContent(from: decoder) { return .variantSetCarousel(v) }
        case "slot":
            if let v = try? SlotContent(from: decoder) { return .slot(v) }
        case "multi_slot":
            if let v = try? MultiSlotContent(from: decoder) { return .multiSlot(v) }
        default:
            break
        }
        return .unknown(type: type)
    }
}

// MARK: - Content Types

struct TitleContent: Decodable {
    let title: String
    let canonical_id: Int?
}

struct BadgeContent: Decodable {
    let text: String
}

struct TagChip: Decodable, Hashable {
    let label: String
    let type: String
}

struct TagChipsContent: Decodable {
    let chips: [TagChip]
}

struct TimeContent: Decodable {
    let prep_min: Int?
    let cook_min: Int?
    let total_min: Int?
}

struct YieldContent: Decodable {
    let unit: String
    let amount: Double
}

struct IngredientGroupContent: Decodable {
    let label: String
}

struct IngredientContent: Decodable {
    let name: String
    let canonical: String?
    let quantity: Double?
    let unit: String?
    let role: String?
    let frequency: Double?
}

struct OptionalIngredientsContent: Decodable {
    let label: String?
    let ingredients: [IngredientContent]
    let collapsed: Bool?
}

struct Variation: Decodable, Hashable {
    let label: String
    let recipe_count: Int?
    let canonical_id: Int?
}

struct VariationChipsContent: Decodable {
    let variations: [Variation]
}

struct EquipmentContent: Decodable {
    let required: [String]?
}

// MARK: - Builder Card Content

struct CompositionHeaderContent: Decodable {
    let composition: String
    let description: String
}

struct VariantIngredient: Decodable, Hashable, Identifiable {
    let name: String
    let frequency: Double
    let count: Int
    var id: String { name }
}

struct VariantSet: Decodable, Identifiable {
    let label: String
    let cuisine: String
    let recipe_count: Int
    let slots: [String: [VariantIngredient]]
    var id: String { cuisine + label }
}

struct VariantSetCarouselContent: Decodable {
    var active_index: Int
    let sets: [VariantSet]
}

struct SlotVariant: Decodable, Identifiable {
    let cuisine: String
    let label: String
    let ingredients: [VariantIngredient]
    var id: String { cuisine + label }
}

struct SlotContent: Decodable {
    let slot_name: String
    let required: Bool
    var active_variant_index: Int
    let variants: [SlotVariant]
    let current: [VariantIngredient]
    var pinned: Bool
}

struct MultiSlotContent: Decodable {
    let slot_name: String
    let required: Bool
    let min_items: Int
    let max_items: Int
    var current_items: [VariantIngredient]
    let variants: [SlotVariant]
    var suggested_additions: [VariantIngredient]?
}

// MARK: - Composition Template

struct CompositionTemplate: Decodable {
    let composition: String
    let stream: [Card]
}

// MARK: - Compositions List

enum BuilderComposition: String, CaseIterable, Identifiable {
    case bowl, pasta, curry, salad, stir_fry, taco, soup
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .stir_fry: return "Stir Fry"
        default: return rawValue.capitalized
        }
    }
    var emoji: String {
        switch self {
        case .bowl: return "🍚"
        case .pasta: return "🍝"
        case .curry: return "🍛"
        case .salad: return "🥗"
        case .stir_fry: return "🥘"
        case .taco: return "🌮"
        case .soup: return "🍲"
        }
    }
}

// MARK: - Formatting Helpers

enum CardFormat {
    /// Convert snake_case to Title Case with special cases.
    static func titleCase(_ s: String) -> String {
        // Special cases
        let special: [String: String] = [
            "sweet_savory": "Sweet & Savory",
            "both": "Sweet & Savory"
        ]
        if let sp = special[s] { return sp }

        return s
            .split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    static func formatQuantity(_ q: Double) -> String {
        // Format common fractions
        let whole = Int(q)
        let frac = q - Double(whole)
        let fracStr: String
        switch (round(frac * 8) / 8) {
        case 0: fracStr = ""
        case 0.125: fracStr = "1/8"
        case 0.25: fracStr = "1/4"
        case 0.333, 0.375: fracStr = "1/3"
        case 0.5: fracStr = "1/2"
        case 0.625, 0.667: fracStr = "2/3"
        case 0.75: fracStr = "3/4"
        case 0.875: fracStr = "7/8"
        default:
            // Fallback to decimal trimmed
            if q == q.rounded() { return "\(Int(q))" }
            return String(format: "%.2f", q).replacingOccurrences(of: ".00", with: "")
        }
        if whole == 0 { return fracStr }
        if fracStr.isEmpty { return "\(whole)" }
        return "\(whole) \(fracStr)"
    }
}
