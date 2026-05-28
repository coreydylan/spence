import Foundation
import SwiftData

enum SessionStatus: String, Codable {
    case inProgress = "in_progress"
    case completed
    case abandoned
}

@Model
final class CookingSession: Codable {
    var id: UUID
    var startedAt: Date
    var completedAt: Date?
    var statusRaw: String
    var currentPhase: String?
    var currentStepId: Int?
    var notes: String?
    var rating: Int?

    var recipe: Recipe?

    // Computed property for enum access
    var status: SessionStatus {
        get { SessionStatus(rawValue: statusRaw) ?? .inProgress }
        set { statusRaw = newValue.rawValue }
    }

    init(
        id: UUID = UUID(),
        startedAt: Date = Date(),
        completedAt: Date? = nil,
        status: SessionStatus = .inProgress,
        currentPhase: String? = nil,
        currentStepId: Int? = nil,
        notes: String? = nil,
        rating: Int? = nil,
        recipe: Recipe? = nil
    ) {
        self.id = id
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.statusRaw = status.rawValue
        self.currentPhase = currentPhase
        self.currentStepId = currentStepId
        self.notes = notes
        self.rating = rating
        self.recipe = recipe
    }

    // MARK: - Codable

    enum CodingKeys: String, CodingKey {
        case id
        case startedAt = "started_at"
        case completedAt = "completed_at"
        case status
        case currentPhase = "current_phase"
        case currentStepId = "current_step_id"
        case notes
        case rating
    }

    required init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        startedAt = try container.decodeIfPresent(Date.self, forKey: .startedAt) ?? Date()
        completedAt = try container.decodeIfPresent(Date.self, forKey: .completedAt)

        let sessionStatus = try container.decodeIfPresent(SessionStatus.self, forKey: .status) ?? .inProgress
        statusRaw = sessionStatus.rawValue

        currentPhase = try container.decodeIfPresent(String.self, forKey: .currentPhase)
        currentStepId = try container.decodeIfPresent(Int.self, forKey: .currentStepId)
        notes = try container.decodeIfPresent(String.self, forKey: .notes)
        rating = try container.decodeIfPresent(Int.self, forKey: .rating)
        recipe = nil
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        try container.encode(id, forKey: .id)
        try container.encode(startedAt, forKey: .startedAt)
        try container.encodeIfPresent(completedAt, forKey: .completedAt)
        try container.encode(status, forKey: .status)
        try container.encodeIfPresent(currentPhase, forKey: .currentPhase)
        try container.encodeIfPresent(currentStepId, forKey: .currentStepId)
        try container.encodeIfPresent(notes, forKey: .notes)
        try container.encodeIfPresent(rating, forKey: .rating)
    }
}
