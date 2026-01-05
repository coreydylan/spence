import Foundation
import SwiftData

enum MeasurementPreference: String, Codable {
    case weight
    case volume
}

enum UnitSystem: String, Codable {
    case metric
    case imperial
}

enum VerbosityLevel: String, Codable {
    case concise
    case detailed
}

@Model
final class UserProfile: Codable {
    var id: UUID
    var measurementPreferenceRaw: String
    var unitSystemRaw: String
    var verbosityRaw: String

    // Computed properties for enum access
    var measurementPreference: MeasurementPreference {
        get { MeasurementPreference(rawValue: measurementPreferenceRaw) ?? .volume }
        set { measurementPreferenceRaw = newValue.rawValue }
    }

    var unitSystem: UnitSystem {
        get { UnitSystem(rawValue: unitSystemRaw) ?? .imperial }
        set { unitSystemRaw = newValue.rawValue }
    }

    var verbosity: VerbosityLevel {
        get { VerbosityLevel(rawValue: verbosityRaw) ?? .detailed }
        set { verbosityRaw = newValue.rawValue }
    }

    init(
        id: UUID = UUID(),
        measurementPreference: MeasurementPreference = .volume,
        unitSystem: UnitSystem = .imperial,
        verbosity: VerbosityLevel = .detailed
    ) {
        self.id = id
        self.measurementPreferenceRaw = measurementPreference.rawValue
        self.unitSystemRaw = unitSystem.rawValue
        self.verbosityRaw = verbosity.rawValue
    }

    // MARK: - Codable

    enum CodingKeys: String, CodingKey {
        case id
        case measurementPreference = "measurement_preference"
        case unitSystem = "unit_system"
        case verbosity
    }

    required init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()

        let measurementPref = try container.decodeIfPresent(MeasurementPreference.self, forKey: .measurementPreference) ?? .volume
        measurementPreferenceRaw = measurementPref.rawValue

        let unitSys = try container.decodeIfPresent(UnitSystem.self, forKey: .unitSystem) ?? .imperial
        unitSystemRaw = unitSys.rawValue

        let verb = try container.decodeIfPresent(VerbosityLevel.self, forKey: .verbosity) ?? .detailed
        verbosityRaw = verb.rawValue
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        try container.encode(id, forKey: .id)
        try container.encode(measurementPreference, forKey: .measurementPreference)
        try container.encode(unitSystem, forKey: .unitSystem)
        try container.encode(verbosity, forKey: .verbosity)
    }
}
