//
//  CheckPhaseView.swift
//  Spence
//
//  Phase 1: Equipment and ingredient checklist
//

import SwiftUI

struct CheckPhaseView: View {
    let recipe: Recipe
    @State private var checkedEquipment: Set<UUID> = []
    @State private var checkedIngredients: Set<UUID> = []
    @State private var showWeightMeasurements = true

    private var allEquipmentChecked: Bool {
        let required = recipe.equipment.filter { $0.required }
        guard !required.isEmpty else { return true }
        return required.allSatisfy { checkedEquipment.contains($0.id) }
    }

    private var allIngredientsChecked: Bool {
        guard !recipe.ingredients.isEmpty else { return true }
        return recipe.ingredients.allSatisfy { checkedIngredients.contains($0.id) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            // Equipment Section
            if !recipe.equipment.isEmpty {
                equipmentSection(equipment: recipe.equipment.sorted { $0.displayOrder < $1.displayOrder })
            }

            // Ingredients Section
            if !recipe.ingredients.isEmpty {
                ingredientsSection(ingredients: recipe.ingredients.sorted { $0.displayOrder < $1.displayOrder })
            }

            // Ready Confirmation
            if allEquipmentChecked && allIngredientsChecked {
                readyBanner
            }
        }
    }

    // MARK: - Equipment Section

    private func equipmentSection(equipment: [RecipeEquipment]) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            SectionHeader(title: "Equipment", icon: "wrench.and.screwdriver")

            VStack(spacing: 8) {
                ForEach(equipment) { item in
                    EquipmentRow(
                        equipment: item,
                        isChecked: checkedEquipment.contains(item.id)
                    ) {
                        toggleEquipment(item.id)
                    }
                }
            }
        }
    }

    // MARK: - Ingredients Section

    private func ingredientsSection(ingredients: [RecipeIngredient]) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                SectionHeader(title: "Ingredients", icon: "carrot")

                Spacer()

                // Unit Toggle
                UnitToggle(showWeight: $showWeightMeasurements)
            }

            // Group by category
            let grouped = Dictionary(grouping: ingredients) { $0.category ?? "other" }
            let sortedCategories = grouped.keys.sorted()

            ForEach(sortedCategories, id: \.self) { category in
                if let items = grouped[category] {
                    CategoryGroup(category: category) {
                        ForEach(items) { ingredient in
                            IngredientRow(
                                ingredient: ingredient,
                                showWeight: showWeightMeasurements,
                                isChecked: checkedIngredients.contains(ingredient.id)
                            ) {
                                toggleIngredient(ingredient.id)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Ready Banner

    private var readyBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 24))
                .foregroundStyle(Color.spenceGreen)

            VStack(alignment: .leading, spacing: 2) {
                Text("You're ready!")
                    .font(.spenceSubheadline)
                    .foregroundStyle(Color.textPrimary)
                Text("You have everything you need")
                    .font(.spenceCaption)
                    .foregroundStyle(Color.textSecondary)
            }

            Spacer()
        }
        .padding(16)
        .background(Color.spenceGreen.opacity(0.15))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.spenceGreen.opacity(0.3), lineWidth: 1)
        )
    }

    // MARK: - Helpers

    private func toggleEquipment(_ id: UUID) {
        withAnimation(.smooth) {
            if checkedEquipment.contains(id) {
                checkedEquipment.remove(id)
            } else {
                checkedEquipment.insert(id)
            }
        }
    }

    private func toggleIngredient(_ id: UUID) {
        withAnimation(.smooth) {
            if checkedIngredients.contains(id) {
                checkedIngredients.remove(id)
            } else {
                checkedIngredients.insert(id)
            }
        }
    }
}

// MARK: - Section Header

struct SectionHeader: View {
    let title: String
    let icon: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color.spenceOrange)

            Text(title)
                .font(.spenceHeadline)
                .foregroundStyle(Color.textPrimary)
        }
    }
}

// MARK: - Unit Toggle

struct UnitToggle: View {
    @Binding var showWeight: Bool

    var body: some View {
        HStack(spacing: 4) {
            Button {
                withAnimation(.smooth) { showWeight = false }
            } label: {
                Text("Vol")
                    .font(.spenceCaptionSmall)
                    .foregroundStyle(!showWeight ? Color.textPrimary : Color.textTertiary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(!showWeight ? Color.glassMedium : Color.clear)
                    .clipShape(Capsule())
            }

            Button {
                withAnimation(.smooth) { showWeight = true }
            } label: {
                Text("Wt")
                    .font(.spenceCaptionSmall)
                    .foregroundStyle(showWeight ? Color.textPrimary : Color.textTertiary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(showWeight ? Color.glassMedium : Color.clear)
                    .clipShape(Capsule())
            }
        }
        .padding(2)
        .background(Color.glassLight)
        .clipShape(Capsule())
    }
}

// MARK: - Equipment Row

struct EquipmentRow: View {
    let equipment: RecipeEquipment
    let isChecked: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 12) {
                // Checkbox
                ZStack {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .stroke(isChecked ? Color.spenceGreen : Color.glassBorder, lineWidth: 2)
                        .frame(width: 24, height: 24)

                    if isChecked {
                        Image(systemName: "checkmark")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(Color.spenceGreen)
                    }
                }

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(equipment.item)
                            .font(.ingredientName)
                            .foregroundStyle(isChecked ? Color.textSecondary : Color.textPrimary)
                            .strikethrough(isChecked)

                        if !equipment.required {
                            Text("optional")
                                .font(.spenceFootnote)
                                .foregroundStyle(Color.textTertiary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.glassLight)
                                .clipShape(Capsule())
                        }
                    }

                    if let notes = equipment.notes {
                        Text(notes)
                            .font(.spenceCaptionSmall)
                            .foregroundStyle(Color.textTertiary)
                    }

                    if let alternative = equipment.alternative {
                        Text("Alt: \(alternative)")
                            .font(.spenceCaptionSmall)
                            .foregroundStyle(Color.spenceAmber)
                    }
                }

                Spacer()
            }
            .padding(12)
            .background(Color.glassLight)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Category Group

struct CategoryGroup<Content: View>: View {
    let category: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(categoryDisplayName)
                .font(.spenceCaption)
                .foregroundStyle(categoryColor)
                .textCase(.uppercase)

            content
        }
    }

    private var categoryDisplayName: String {
        switch category.lowercased() {
        case "produce": return "Produce"
        case "protein": return "Protein"
        case "dairy": return "Dairy"
        case "pantry": return "Pantry"
        case "spices": return "Spices"
        case "oils-vinegars": return "Oils & Vinegars"
        default: return category.capitalized
        }
    }

    private var categoryColor: Color {
        switch category.lowercased() {
        case "produce": return .categoryProduce
        case "protein": return .categoryProtein
        case "dairy": return .categoryDairy
        case "pantry": return .categoryPantry
        case "spices": return .categorySpices
        case "oils-vinegars": return .categoryOilsVinegars
        default: return .textSecondary
        }
    }
}

// MARK: - Ingredient Row

struct IngredientRow: View {
    let ingredient: RecipeIngredient
    let showWeight: Bool
    let isChecked: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 12) {
                // Checkbox
                ZStack {
                    Circle()
                        .stroke(isChecked ? Color.spenceGreen : Color.glassBorder, lineWidth: 2)
                        .frame(width: 24, height: 24)

                    if isChecked {
                        Circle()
                            .fill(Color.spenceGreen)
                            .frame(width: 16, height: 16)
                    }
                }

                // Quantity
                Text(quantityText)
                    .font(.ingredientQuantity)
                    .foregroundStyle(Color.textSecondary)
                    .frame(width: 80, alignment: .leading)

                // Item name and prep
                VStack(alignment: .leading, spacing: 2) {
                    Text(ingredient.item)
                        .font(.ingredientName)
                        .foregroundStyle(isChecked ? Color.textSecondary : Color.textPrimary)
                        .strikethrough(isChecked)

                    if let prep = ingredient.prep {
                        Text(prep)
                            .font(.spenceCaptionSmall)
                            .foregroundStyle(Color.textTertiary)
                    }
                }

                Spacer()
            }
            .padding(12)
            .background(Color.glassLight)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var quantityText: String {
        if showWeight, let weight = ingredient.quantityWeightG {
            return "\(weight)g"
        } else if let volume = ingredient.quantityVolume {
            return volume
        } else {
            return ingredient.quantityDisplay ?? ""
        }
    }
}

#Preview {
    ScrollView {
        CheckPhaseView(recipe: Recipe.preview)
            .padding()
    }
    .background(Color.spenceBackground)
}
