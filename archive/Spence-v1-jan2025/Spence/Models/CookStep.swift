import Foundation
import SwiftData

@Model
final class CookStep: Codable {
    var id: Int
    var stepNumber: Int
    var instruction: String
    var timeMinutes: Double?
    var dependsOn: [Int]
    var usesOutputs: [String]
    var cueVisual: String?
    var cueAudio: String?
    var cueAroma: String?
    var warnings: String?

    var recipe: Recipe?

    init(
        id: Int,
        stepNumber: Int,
        instruction: String,
        timeMinutes: Double? = nil,
        dependsOn: [Int] = [],
        usesOutputs: [String] = [],
        cueVisual: String? = nil,
        cueAudio: String? = nil,
        cueAroma: String? = nil,
        warnings: String? = nil,
        recipe: Recipe? = nil
    ) {
        self.id = id
        self.stepNumber = stepNumber
        self.instruction = instruction
        self.timeMinutes = timeMinutes
        self.dependsOn = dependsOn
        self.usesOutputs = usesOutputs
        self.cueVisual = cueVisual
        self.cueAudio = cueAudio
        self.cueAroma = cueAroma
        self.warnings = warnings
        self.recipe = recipe
    }

    // MARK: - Codable

    enum CodingKeys: String, CodingKey {
        case id
        case instruction
        case timeMinutes = "time_minutes"
        case dependsOn = "depends_on"
        case usesOutputs = "uses_outputs"
        case cues
        case warnings
    }

    enum CuesKeys: String, CodingKey {
        case visual
        case audio
        case aroma
    }

    required init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        let decodedId = try container.decode(Int.self, forKey: .id)
        id = decodedId
        stepNumber = decodedId
        instruction = try container.decode(String.self, forKey: .instruction)
        timeMinutes = try container.decodeIfPresent(Double.self, forKey: .timeMinutes)
        dependsOn = try container.decodeIfPresent([Int].self, forKey: .dependsOn) ?? []
        usesOutputs = try container.decodeIfPresent([String].self, forKey: .usesOutputs) ?? []

        // Decode cues nested object
        if let cuesContainer = try? container.nestedContainer(keyedBy: CuesKeys.self, forKey: .cues) {
            cueVisual = try cuesContainer.decodeIfPresent(String.self, forKey: .visual)
            cueAudio = try cuesContainer.decodeIfPresent(String.self, forKey: .audio)
            cueAroma = try cuesContainer.decodeIfPresent(String.self, forKey: .aroma)
        } else {
            cueVisual = nil
            cueAudio = nil
            cueAroma = nil
        }

        warnings = try container.decodeIfPresent(String.self, forKey: .warnings)
        recipe = nil
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        try container.encode(id, forKey: .id)
        try container.encode(instruction, forKey: .instruction)
        try container.encodeIfPresent(timeMinutes, forKey: .timeMinutes)
        try container.encode(dependsOn, forKey: .dependsOn)
        try container.encode(usesOutputs, forKey: .usesOutputs)

        // Encode cues as nested object
        var cuesContainer = container.nestedContainer(keyedBy: CuesKeys.self, forKey: .cues)
        try cuesContainer.encodeIfPresent(cueVisual, forKey: .visual)
        try cuesContainer.encodeIfPresent(cueAudio, forKey: .audio)
        try cuesContainer.encodeIfPresent(cueAroma, forKey: .aroma)

        try container.encodeIfPresent(warnings, forKey: .warnings)
    }
}
