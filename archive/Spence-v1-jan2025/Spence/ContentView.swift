//
//  ContentView.swift
//  Spence
//
//  Main content view with tab navigation
//

import SwiftUI
import SwiftData

struct ContentView: View {
    @Environment(\.modelContext) private var modelContext
    @State private var selectedTab: Tab = .home

    enum Tab: String, CaseIterable {
        case home = "Recipes"
        case favorites = "Favorites"
        case settings = "Settings"

        var icon: String {
            switch self {
            case .home: return "book.pages"
            case .favorites: return "heart.fill"
            case .settings: return "gearshape"
            }
        }
    }

    var body: some View {
        ZStack {
            // Ambient animated background
            AmbientBackground()
                .ignoresSafeArea()

            TabView(selection: $selectedTab) {
                HomeView()
                    .tabItem {
                        Label(Tab.home.rawValue, systemImage: Tab.home.icon)
                    }
                    .tag(Tab.home)

                FavoritesView()
                    .tabItem {
                        Label(Tab.favorites.rawValue, systemImage: Tab.favorites.icon)
                    }
                    .tag(Tab.favorites)

                SettingsView()
                    .tabItem {
                        Label(Tab.settings.rawValue, systemImage: Tab.settings.icon)
                    }
                    .tag(Tab.settings)
            }
            .tint(Color.spenceOrange)
        }
    }
}

// MARK: - Placeholder Views (to be replaced)

struct FavoritesView: View {
    var body: some View {
        ZStack {
            Color.clear
            Text("Favorites")
                .font(.spenceTitle)
                .foregroundStyle(Color.textPrimary)
        }
    }
}

#Preview {
    ContentView()
        .modelContainer(for: Recipe.self, inMemory: true)
}
