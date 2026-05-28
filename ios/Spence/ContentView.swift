import SwiftUI

struct ContentView: View {
    @State private var searchText = ""
    @State private var dishes: [DishResult] = []
    @State private var status: PipelineStatus?
    @State private var isLoading = true
    @State private var showingBuilder = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Omnibar
                HStack(spacing: 12) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField("What are you making?", text: $searchText)
                        .textFieldStyle(.plain)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await search() } }
                    if !searchText.isEmpty {
                        Button { searchText = ""; Task { await search() } } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .padding(.horizontal)
                .padding(.top, 8)

                if isLoading {
                    Spacer()
                    ProgressView("Loading dishes...")
                    Spacer()
                } else if dishes.isEmpty {
                    Spacer()
                    ContentUnavailableView(
                        searchText.isEmpty ? "No dishes yet" : "No results",
                        systemImage: searchText.isEmpty ? "fork.knife" : "magnifyingglass",
                        description: Text(searchText.isEmpty ? "Dishes are being built" : "Try a different search")
                    )
                    Spacer()
                } else {
                    List {
                        // Stats header
                        if let status {
                            Section {
                                HStack {
                                    StatBadge(value: "\(status.total_raw_recipes)", label: "Recipes")
                                    StatBadge(value: "\(status.sources.count)", label: "Sources")
                                    StatBadge(value: "\(status.canonical.ingredients)", label: "Ingredients")
                                    StatBadge(value: "\(status.canonical.edges)", label: "Affinities")
                                }
                                .listRowBackground(Color.clear)
                                .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                            }
                        }

                        // Dish list
                        Section("Dishes\(searchText.isEmpty ? "" : " matching \"\(searchText)\"")") {
                            ForEach(dishes) { dish in
                                NavigationLink(value: dish.id) {
                                    DishRow(dish: dish)
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Spence")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingBuilder = true
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .font(.title3)
                    }
                }
            }
            .sheet(isPresented: $showingBuilder) {
                CompositionPickerView()
            }
            .navigationDestination(for: Int.self) { id in
                CardStreamView(dishID: id)
            }
            .refreshable {
                await loadAll()
            }
            .task {
                await loadAll()
            }
            .onChange(of: searchText) {
                Task {
                    try? await Task.sleep(for: .milliseconds(300))
                    await search()
                }
            }
        }
    }

    func loadAll() async {
        isLoading = true
        async let s = try? SpenceAPI.fetchStatus()
        async let d = try? SpenceAPI.searchDishes()
        status = await s
        dishes = await d ?? []
        isLoading = false
    }

    func search() async {
        dishes = (try? await SpenceAPI.searchDishes(query: searchText)) ?? []
    }
}

struct StatBadge: View {
    let value: String
    let label: String

    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(.title3, design: .rounded, weight: .bold))
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

struct DishRow: View {
    let dish: DishResult

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(dish.canonical_title.capitalized)
                .font(.body.weight(.medium))
                .lineLimit(2)

            HStack(spacing: 8) {
                if let comp = dish.composition {
                    Text(CardFormat.titleCase(comp))
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.orange.opacity(0.15))
                        .foregroundStyle(.orange)
                        .clipShape(Capsule())
                }
                if let count = dish.recipe_count, count > 0 {
                    Label("\(count) recipes", systemImage: "doc.text")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let time = dish.consensus_total_time, time > 0 {
                    Label("\(time) min", systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
