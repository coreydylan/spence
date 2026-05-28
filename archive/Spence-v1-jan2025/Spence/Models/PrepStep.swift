import Foundation
import SwiftData

@Model
final class PrepStep: Codable {
    var id: Int
    var stepNumber: Int
    var instruction: String
    var outputs: [String]
    var container: String?
    var station: String?
    var timeMinutes: Double?
    var notes: String?

    var recipe: Recipe?

    init(
        id: Int,
        stepNumber: Int,
        instruction: String,
        outputs: [String] = [],
        container: String? = nil,
        station: String? = nil,
        timeMinutes: Double? = nil,
        notes: String? = nil,
        recipe: Recipe? = nil
    ) {
        self.id = id
        self.stepNumber = stepNumber
        self.instruction = instruction
        self.outputs = outputs
        self.container = container
        self.station = station
        self.timeMinutes = timeMinutes
        self.notes = notes
        self.recipe = recipe
    }

    // MARK: - Codable

    enum CodingKeys: String, CodingKey {
        case id
        case instruction
        case outputs
        case container
        case station
        case timeMinutes = "time_minutes"
        case notes
    }

    required init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        let decodedId = try container.decode(Int.self, forKey: .id)
        id = decodedId
        stepNumber = decodedId
        instruction = try container.decode(String.self, forKey: .instruction)
        outputs = try container.decodeIfPresent([String].self, forKey: .outputs) ?? []
        self.container = try container.decodeIfPresent(String.self, forKey: .container)
        station = try container.decodeIfPresent(String.self, forKey: .station)
        timeMinutes = try container.decodeIfPresent(Double.self, forKey: .timeMinutes)
        notes = try container.decodeIfPresent(String.self, forKey: .notes)
        recipe = nil
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        try container.encode(id, forKey: .id)
        try container.encode(instruction, forKey: .instruction)
        try container.encode(outputs, forKey: .outputs)
        try container.encodeIfPresent(self.container, forKey: .container)
        try container.encodeIfPresent(station, forKey: .station)
        try container.encodeIfPresent(timeMinutes, forKey: .timeMinutes)
        try container.encodeIfPresent(notes, forKey: .notes)
    }
}
