//
//  RecipeDetailView.swift
//  Spence
//
//  Full recipe view with hero photo and three-phase tabs
//

import SwiftUI
import SwiftData

struct RecipeDetailView: View {
    let recipe: Recipe
    @State private var selectedPhase: RecipePhase = .check
    @State private var showCookMode = false
    @State private var headerOffset: CGFloat = 0

    enum RecipePhase: String, CaseIterable {
        case check = "CHECK"
        case prep = "PREP"
        case cook = "COOK"

        var icon: String {
            switch self {
            case .check: return "checkmark.circle"
            case .prep: return "knife"
            case .cook: return "flame"
            }
        }

        var color: Color {
            switch self {
            case .check: return .phaseCheck
            case .prep: return .phasePrep
            case .cook: return .phaseCook
            }
        }
    }

    var body: some View {
        ZStack {
            // Background
            AmbientBackground()
                .ignoresSafeArea()

            ScrollView {
                VStack(spacing: 0) {
                    // Hero Header
                    RecipeHeaderView(recipe: recipe)
                        .frame(height: 320)

                    // Content Card
                    VStack(spacing: 24) {
                        // Recipe Info Bar
                        recipeInfoBar

                        // Phase Tabs
                        PhaseTabBar(selectedPhase: $selectedPhase)

                        // Phase Content
                        phaseContent
                            .animation(.smooth, value: selectedPhase)

                        // Start Cooking Button
                        if selectedPhase == .cook {
                            startCookingButton
                                .padding(.top, 8)
                        }

                        Spacer(minLength: 100)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 24)
                    .background(
                        RoundedRectangle(cornerRadius: 32, style: .continuous)
                            .fill(Color.spenceBackground.opacity(0.95))
                            .overlay(
                                RoundedRectangle(cornerRadius: 32, style: .continuous)
                                    .stroke(Color.glassBorder, lineWidth: 1)
                            )
                    )
                    .offset(y: -32)
                }
            }
            .ignoresSafeArea(edges: .top)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
        .fullScreenCover(isPresented: $showCookMode) {
            CookModeView(recipe: recipe)
        }
    }

    // MARK: - Recipe Info Bar

    private var recipeInfoBar: some View {
        HStack(spacing: 20) {
            // Total Time
            InfoBadge(
                icon: "clock",
                value: "\(recipe.totalMinutes ?? 0)",
                unit: "min"
            )

            // Yield
            InfoBadge(
                icon: "person.2",
                value: recipe.yieldText,
                unit: nil
            )

            // Rating
            if let rating = recipe.rating, rating > 0 {
                HStack(spacing: 4) {
                    ForEach(1...5, id: \.self) { star in
                        Image(systemName: star <= rating ? "star.fill" : "star")
                            .font(.system(size: 14))
                            .foregroundStyle(star <= rating ? Color.spenceAmber : Color.textTertiary)
                    }
                }
            }

            Spacer()

            // Favorite Button
            Button {
                recipe.isFavorite.toggle()
            } label: {
                Image(systemName: recipe.isFavorite ? "heart.fill" : "heart")
                    .font(.system(size: 22))
                    .foregroundStyle(recipe.isFavorite ? Color.spenceRed : Color.textSecondary)
            }
        }
    }

    // MARK: - Phase Content

    @ViewBuilder
    private var phaseContent: some View {
        switch selectedPhase {
        case .check:
            CheckPhaseView(recipe: recipe)
        case .prep:
            PrepPhaseView(recipe: recipe)
        case .cook:
            CookPhaseView(recipe: recipe)
        }
    }

    // MARK: - Start Cooking Button

    private var startCookingButton: some View {
        Button {
            showCookMode = true
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "flame.fill")
                    .font(.system(size: 20))
                Text("Start Cooking")
                    .font(.buttonPrimary)
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
            .background(
                LinearGradient.spenceOrangeGradient
            )
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .shadow(color: Color.spenceOrange.opacity(0.4), radius: 12, y: 6)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Info Badge

struct InfoBadge: View {
    let icon: String
    let value: String
    let unit: String?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(Color.textTertiary)

            Text(value)
                .font(.spenceCaption)
                .foregroundStyle(Color.textPrimary)

            if let unit = unit {
                Text(unit)
                    .font(.spenceCaptionSmall)
                    .foregroundStyle(Color.textSecondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.glassLight)
        .clipShape(Capsule())
    }
}

// MARK: - Phase Tab Bar

struct PhaseTabBar: View {
    @Binding var selectedPhase: RecipeDetailView.RecipePhase
    @Namespace private var namespace

    var body: some View {
        HStack(spacing: 8) {
            ForEach(RecipeDetailView.RecipePhase.allCases, id: \.self) { phase in
                PhaseTab(
                    phase: phase,
                    isSelected: selectedPhase == phase,
                    namespace: namespace
                ) {
                    withAnimation(.springy) {
                        selectedPhase = phase
                    }
                }
            }
        }
        .padding(4)
        .background(Color.glassLight)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct PhaseTab: View {
    let phase: RecipeDetailView.RecipePhase
    let isSelected: Bool
    let namespace: Namespace.ID
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: phase.icon)
                    .font(.system(size: 14, weight: .semibold))
                Text(phase.rawValue)
                    .font(.spenceCaption)
            }
            .foregroundStyle(isSelected ? .white : Color.textSecondary)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background {
                if isSelected {
                    Capsule()
                        .fill(phase.color)
                        .matchedGeometryEffect(id: "phaseTab", in: namespace)
                }
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Recipe Header

struct RecipeHeaderView: View {
    let recipe: Recipe

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottomLeading) {
                // Photo or Gradient Placeholder
                if let primaryPhoto = recipe.photos.first(where: { $0.isPrimary }) ?? recipe.photos.first {
                    AsyncImage(url: URL(string: primaryPhoto.storagePath ?? "")) { image in
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } placeholder: {
                        placeholderGradient
                    }
                    .frame(width: geo.size.width, height: geo.size.height)
                    .clipped()
                } else {
                    placeholderGradient
                }

                // Gradient Overlay
                LinearGradient(
                    colors: [.clear, Color.spenceBackground.opacity(0.8)],
                    startPoint: .top,
                    endPoint: .bottom
                )

                // Title
                VStack(alignment: .leading, spacing: 8) {
                    Text(recipe.name)
                        .font(.spenceTitle)
                        .foregroundStyle(Color.textPrimary)

                    if let description = recipe.recipeDescription {
                        Text(description)
                            .font(.spenceBody)
                            .foregroundStyle(Color.textSecondary)
                            .lineLimit(2)
                    }

                    Text("From \(recipe.source)")
                        .font(.spenceCaption)
                        .foregroundStyle(Color.textTertiary)
                }
                .padding(24)
            }
        }
    }

    private var placeholderGradient: some View {
        LinearGradient(
            colors: [
                Color.spenceOrange.opacity(0.3),
                Color.spenceAmber.opacity(0.2),
                Color.spenceBackground
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

#Preview {
    NavigationStack {
        RecipeDetailView(recipe: Recipe.preview)
    }
}
