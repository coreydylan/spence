//
//  SettingsView.swift
//  Spence
//
//  User preferences and settings
//

import SwiftUI

struct SettingsView: View {
    @AppStorage("measurementPreference") private var measurementPreference = "weight"
    @AppStorage("unitSystem") private var unitSystem = "metric"
    @AppStorage("verbosity") private var verbosity = "detailed"
    @AppStorage("keepScreenAwake") private var keepScreenAwake = true
    @AppStorage("hapticFeedback") private var hapticFeedback = true

    var body: some View {
        ZStack {
            Color.clear

            ScrollView {
                VStack(spacing: 24) {
                    // Header
                    Text("Settings")
                        .font(.spenceTitle)
                        .foregroundStyle(Color.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.bottom, 8)

                    // Measurement Preferences
                    SettingsSection(title: "Measurements", icon: "ruler") {
                        SettingsPicker(
                            title: "Default Display",
                            selection: $measurementPreference,
                            options: [
                                ("weight", "Weight (grams)"),
                                ("volume", "Volume (cups)")
                            ]
                        )

                        SettingsPicker(
                            title: "Unit System",
                            selection: $unitSystem,
                            options: [
                                ("metric", "Metric"),
                                ("imperial", "Imperial")
                            ]
                        )
                    }

                    // Cook Mode
                    SettingsSection(title: "Cook Mode", icon: "flame") {
                        SettingsToggle(
                            title: "Keep Screen Awake",
                            subtitle: "Prevent screen dimming while cooking",
                            isOn: $keepScreenAwake
                        )

                        SettingsToggle(
                            title: "Haptic Feedback",
                            subtitle: "Vibrations for timers and navigation",
                            isOn: $hapticFeedback
                        )

                        SettingsPicker(
                            title: "Instruction Detail",
                            selection: $verbosity,
                            options: [
                                ("concise", "Concise"),
                                ("detailed", "Detailed")
                            ]
                        )
                    }

                    // Equipment
                    SettingsSection(title: "My Kitchen", icon: "house") {
                        NavigationLink {
                            EquipmentSettingsView()
                        } label: {
                            SettingsRow(
                                title: "Equipment I Own",
                                subtitle: "Recipes adapt based on your tools"
                            )
                        }
                    }

                    // About
                    SettingsSection(title: "About", icon: "info.circle") {
                        SettingsRow(
                            title: "Spence",
                            subtitle: "Version 1.0.0"
                        )

                        SettingsRow(
                            title: "Made with ♥",
                            subtitle: "For home cooks everywhere"
                        )
                    }

                    Spacer(minLength: 100)
                }
                .padding(20)
            }
        }
    }
}

// MARK: - Settings Section

struct SettingsSection<Content: View>: View {
    let title: String
    let icon: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Section Header
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.spenceOrange)

                Text(title)
                    .font(.spenceSubheadline)
                    .foregroundStyle(Color.textPrimary)
            }

            // Content
            VStack(spacing: 1) {
                content
            }
            .background(Color.glassLight)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }
}

// MARK: - Settings Row

struct SettingsRow: View {
    let title: String
    let subtitle: String?

    init(title: String, subtitle: String? = nil) {
        self.title = title
        self.subtitle = subtitle
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.spenceBody)
                    .foregroundStyle(Color.textPrimary)

                if let subtitle = subtitle {
                    Text(subtitle)
                        .font(.spenceCaptionSmall)
                        .foregroundStyle(Color.textTertiary)
                }
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.textTertiary)
        }
        .padding(16)
        .contentShape(Rectangle())
    }
}

// MARK: - Settings Toggle

struct SettingsToggle: View {
    let title: String
    let subtitle: String?
    @Binding var isOn: Bool

    init(title: String, subtitle: String? = nil, isOn: Binding<Bool>) {
        self.title = title
        self.subtitle = subtitle
        self._isOn = isOn
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.spenceBody)
                    .foregroundStyle(Color.textPrimary)

                if let subtitle = subtitle {
                    Text(subtitle)
                        .font(.spenceCaptionSmall)
                        .foregroundStyle(Color.textTertiary)
                }
            }

            Spacer()

            Toggle("", isOn: $isOn)
                .tint(Color.spenceOrange)
                .labelsHidden()
        }
        .padding(16)
    }
}

// MARK: - Settings Picker

struct SettingsPicker: View {
    let title: String
    @Binding var selection: String
    let options: [(value: String, label: String)]

    var body: some View {
        HStack {
            Text(title)
                .font(.spenceBody)
                .foregroundStyle(Color.textPrimary)

            Spacer()

            Menu {
                ForEach(options, id: \.value) { option in
                    Button {
                        selection = option.value
                    } label: {
                        HStack {
                            Text(option.label)
                            if selection == option.value {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(options.first { $0.value == selection }?.label ?? "")
                        .font(.spenceCaption)
                        .foregroundStyle(Color.textSecondary)

                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.textTertiary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.glassMedium)
                .clipShape(Capsule())
            }
        }
        .padding(16)
    }
}

// MARK: - Equipment Settings View

struct EquipmentSettingsView: View {
    @State private var equipment: [EquipmentItem] = EquipmentItem.defaultList

    var body: some View {
        ZStack {
            AmbientBackground()
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("My Equipment")
                        .font(.spenceTitle)
                        .foregroundStyle(Color.textPrimary)

                    Text("Check the items you have. Recipes will adapt based on your equipment.")
                        .font(.spenceBody)
                        .foregroundStyle(Color.textSecondary)

                    VStack(spacing: 8) {
                        ForEach($equipment) { $item in
                            EquipmentToggleRow(item: $item)
                        }
                    }
                }
                .padding(20)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct EquipmentItem: Identifiable {
    let id = UUID()
    let name: String
    let icon: String
    var owned: Bool

    static let defaultList: [EquipmentItem] = [
        EquipmentItem(name: "Kitchen Scale", icon: "scalemass", owned: true),
        EquipmentItem(name: "Instant-Read Thermometer", icon: "thermometer.medium", owned: true),
        EquipmentItem(name: "Stand Mixer", icon: "gearshape.2", owned: false),
        EquipmentItem(name: "Food Processor", icon: "cpu", owned: true),
        EquipmentItem(name: "Immersion Blender", icon: "wand.and.rays", owned: true),
        EquipmentItem(name: "Dutch Oven", icon: "flame", owned: true),
        EquipmentItem(name: "Cast Iron Skillet", icon: "frying.pan", owned: true),
        EquipmentItem(name: "Mandoline", icon: "slider.horizontal.3", owned: false),
        EquipmentItem(name: "Kitchen Torch", icon: "flame.fill", owned: false),
        EquipmentItem(name: "Sous Vide", icon: "water.waves", owned: false),
    ]
}

struct EquipmentToggleRow: View {
    @Binding var item: EquipmentItem

    var body: some View {
        Button {
            withAnimation(.smooth) {
                item.owned.toggle()
            }
            HapticsService.shared.itemChecked()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: item.icon)
                    .font(.system(size: 20))
                    .foregroundStyle(item.owned ? Color.spenceOrange : Color.textTertiary)
                    .frame(width: 32)

                Text(item.name)
                    .font(.spenceBody)
                    .foregroundStyle(item.owned ? Color.textPrimary : Color.textSecondary)

                Spacer()

                Image(systemName: item.owned ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22))
                    .foregroundStyle(item.owned ? Color.spenceGreen : Color.glassBorder)
            }
            .padding(16)
            .background(Color.glassLight)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    NavigationStack {
        SettingsView()
    }
}
