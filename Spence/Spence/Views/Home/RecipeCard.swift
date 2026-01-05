//
//  RecipeCard.swift
//  Spence
//
//  Glass card for recipe grid display
//

import SwiftUI

struct RecipeCard: View {
    let recipeName: String
    let photoURL: URL?
    let totalMinutes: Int?
    let isFavorited: Bool
    let rating: Double?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(spacing: 0) {
                // Hero Photo
                recipeImage
                    .frame(height: 180)
                    .clipped()

                // Recipe Info Overlay
                VStack(alignment: .leading, spacing: 8) {
                    Text(recipeName)
                        .font(.spenceSubheadline)
                        .foregroundStyle(Color.textPrimary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    HStack(spacing: 12) {
                        // Time badge
                        if let totalMinutes {
                            HStack(spacing: 4) {
                                Image(systemName: "clock")
                                    .font(.spenceCaptionSmall)
                                Text("\(totalMinutes) min")
                                    .font(.spenceCaptionSmall)
                            }
                            .foregroundStyle(Color.textSecondary)
                        }

                        Spacer()

                        // Rating stars
                        if let rating {
                            ratingStars(rating: rating)
                        }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    Rectangle()
                        .fill(LinearGradient.glassInner)
                        .overlay {
                            Rectangle()
                                .fill(Color.glassMedium)
                        }
                }
            }
            .background(Color.spenceBackground)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color.glassBorder, lineWidth: 1)
            }
            .shadow(color: Color.glassShadow, radius: 8, x: 0, y: 4)

            // Time badge overlay (top-left corner)
            if let totalMinutes {
                Text("\(totalMinutes) min")
                    .font(.spenceCaptionSmall)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.spenceBackground)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background {
                        Capsule(style: .continuous)
                            .fill(Color.spenceAmber)
                            .shadow(color: Color.black.opacity(0.3), radius: 4, x: 0, y: 2)
                    }
                    .padding([.top, .leading], 12)
            }

            // Favorite heart badge (top-right corner)
            if isFavorited {
                Image(systemName: "heart.fill")
                    .font(.spenceBody)
                    .foregroundStyle(Color.spenceRed)
                    .padding(8)
                    .background {
                        Circle()
                            .fill(Color.glassMedium)
                            .shadow(color: Color.black.opacity(0.3), radius: 4, x: 0, y: 2)
                    }
                    .padding([.top, .trailing], 12)
            }
        }
        .contentShape(Rectangle())
    }

    // MARK: - Recipe Image

    @ViewBuilder
    private var recipeImage: some View {
        if let photoURL {
            AsyncImage(url: photoURL) { phase in
                switch phase {
                case .empty:
                    placeholderGradient
                        .overlay {
                            ProgressView()
                                .tint(Color.spenceOrange)
                        }
                case .success(let image):
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                case .failure:
                    placeholderGradient
                        .overlay {
                            Image(systemName: "photo")
                                .font(.system(size: 40))
                                .foregroundStyle(Color.textTertiary)
                        }
                @unknown default:
                    placeholderGradient
                }
            }
        } else {
            placeholderGradient
                .overlay {
                    Image(systemName: "fork.knife")
                        .font(.system(size: 50))
                        .foregroundStyle(Color.textTertiary)
                }
        }
    }

    private var placeholderGradient: some View {
        LinearGradient(
            colors: [
                Color.spenceOrange.opacity(0.3),
                Color.spenceAmber.opacity(0.2),
                Color.spenceOrange.opacity(0.15)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    // MARK: - Rating Stars

    private func ratingStars(rating: Double) -> some View {
        HStack(spacing: 2) {
            ForEach(0..<5) { index in
                Image(systemName: starIcon(for: index, rating: rating))
                    .font(.spenceCaptionSmall)
                    .foregroundStyle(Color.spenceAmber)
            }
        }
    }

    private func starIcon(for index: Int, rating: Double) -> String {
        let position = Double(index) + 1
        if rating >= position {
            return "star.fill"
        } else if rating >= position - 0.5 {
            return "star.leadinghalf.filled"
        } else {
            return "star"
        }
    }
}

#Preview("With Photo & Favorite") {
    ZStack {
        Color.spenceBackground.ignoresSafeArea()

        RecipeCard(
            recipeName: "Classic Carbonara",
            photoURL: URL(string: "https://picsum.photos/400/300"),
            totalMinutes: 25,
            isFavorited: true,
            rating: 4.5
        )
        .frame(width: 200)
        .padding()
    }
}

#Preview("No Photo") {
    ZStack {
        Color.spenceBackground.ignoresSafeArea()

        RecipeCard(
            recipeName: "Grandma's Secret Soup with Extra Long Name",
            photoURL: nil,
            totalMinutes: 120,
            isFavorited: false,
            rating: 5.0
        )
        .frame(width: 200)
        .padding()
    }
}

#Preview("Minimal Info") {
    ZStack {
        Color.spenceBackground.ignoresSafeArea()

        RecipeCard(
            recipeName: "Quick Stir-Fry",
            photoURL: nil,
            totalMinutes: nil,
            isFavorited: false,
            rating: nil
        )
        .frame(width: 200)
        .padding()
    }
}

#Preview("Grid Layout") {
    ZStack {
        Color.spenceBackground.ignoresSafeArea()

        ScrollView {
            LazyVGrid(columns: [
                GridItem(.adaptive(minimum: 160, maximum: 200), spacing: 16)
            ], spacing: 16) {
                ForEach(0..<6) { index in
                    RecipeCard(
                        recipeName: "Recipe \(index + 1)",
                        photoURL: index.isMultiple(of: 2) ? URL(string: "https://picsum.photos/400/300?random=\(index)") : nil,
                        totalMinutes: [15, 30, 45, 60, 90][index % 5],
                        isFavorited: index.isMultiple(of: 3),
                        rating: [4.5, 5.0, 3.5, 4.0, nil][index % 5]
                    )
                }
            }
            .padding()
        }
    }
}
