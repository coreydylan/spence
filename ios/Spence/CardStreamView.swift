import SwiftUI

// MARK: - Card Stream View

struct CardStreamView: View {
    let dishID: Int

    @State private var stream: CardStream?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Loading recipe...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage {
                ContentUnavailableView(
                    "Couldn't load recipe",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage)
                )
            } else if let stream {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        ForEach(stream.stream) { card in
                            cardView(for: card)
                                .padding(.horizontal, 20)
                        }
                    }
                    .padding(.vertical, 16)
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await load()
        }
    }

    @ViewBuilder
    private func cardView(for card: Card) -> some View {
        switch card.content {
        case .title(let c):
            TitleCardView(content: c, isInferred: card.isInferred)
        case .canonicalBadge(let c):
            CanonicalBadgeCardView(content: c)
        case .tagChips(let c):
            TagChipsCardView(content: c)
        case .time(let c):
            TimeCardView(content: c, isInferred: card.isInferred)
        case .yield(let c):
            YieldCardView(content: c, isInferred: card.isInferred)
        case .ingredientGroup(let c):
            IngredientGroupCardView(content: c)
        case .ingredient(let c):
            IngredientCardView(content: c, isInferred: card.isInferred)
        case .optionalIngredients(let c):
            OptionalIngredientsCardView(content: c, isInferred: card.isInferred)
        case .variationChips(let c):
            VariationChipsCardView(content: c)
        case .equipment(let c):
            EquipmentCardView(content: c)
        case .compositionHeader(let c):
            CompositionHeaderCardView(content: c)
        case .variantSetCarousel(let c):
            VariantSetCarouselCardView(content: c)
        case .slot(let c):
            SlotCardView(content: c)
        case .multiSlot(let c):
            MultiSlotCardView(content: c)
        case .unknown(let type):
            UnknownCardView(type: type)
        }
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        do {
            stream = try await SpenceAPI.fetchDishStream(id: dishID)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: - Title Card

struct TitleCardView: View {
    let content: TitleContent
    let isInferred: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(content.title)
                .font(.system(size: 34, weight: .bold, design: .serif))
                .italic(isInferred)
            if isInferred {
                Text("✨")
                    .font(.title3)
                    .opacity(0.6)
            }
            Spacer()
        }
        .padding(.top, 4)
    }
}

// MARK: - Canonical Badge Card

struct CanonicalBadgeCardView: View {
    let content: BadgeContent

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkles")
                .font(.caption2)
            Text(content.text)
                .font(.caption.weight(.medium))
        }
        .foregroundStyle(.purple)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.purple.opacity(0.12))
        .clipShape(Capsule())
    }
}

// MARK: - Tag Chips Card

struct TagChipsCardView: View {
    let content: TagChipsContent

    func color(for type: String) -> Color {
        switch type {
        case "composition": return .orange
        case "meal": return .blue
        case "sweet_savory": return .pink
        case "effort": return .green
        case "cuisine": return .red
        case "season": return .teal
        case "diet": return .mint
        default: return .gray
        }
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(content.chips, id: \.self) { chip in
                    let c = color(for: chip.type)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(CardFormat.titleCase(chip.label))
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(c)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(c.opacity(0.12))
                    .overlay(
                        Capsule().stroke(c.opacity(0.25), lineWidth: 1)
                    )
                    .clipShape(Capsule())
                }
            }
        }
    }
}

// MARK: - Time Card

struct TimeCardView: View {
    let content: TimeContent
    let isInferred: Bool

    var body: some View {
        HStack(spacing: 20) {
            if let prep = content.prep_min {
                timeItem(label: "Prep", value: "\(prep) min")
            }
            if let cook = content.cook_min {
                timeItem(label: "Cook", value: "\(cook) min")
            }
            if let total = content.total_min {
                timeItem(label: "Total", value: "\(total) min")
            }
            Spacer()
        }
        .padding(12)
        .background(.fill.quinary)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .italic(isInferred)
    }

    func timeItem(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.weight(.medium))
        }
    }
}

// MARK: - Yield Card

struct YieldCardView: View {
    let content: YieldContent
    let isInferred: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "person.2.fill")
                .foregroundStyle(.secondary)
                .font(.footnote)
            Text(text)
                .font(.subheadline.weight(.medium))
                .italic(isInferred)
            Spacer()
        }
    }

    var text: String {
        let amt = content.amount == content.amount.rounded()
            ? "\(Int(content.amount))"
            : String(format: "%.1f", content.amount)
        let verb = content.unit.capitalized
        return "\(verb) \(amt)"
    }
}

// MARK: - Ingredient Group Card

struct IngredientGroupCardView: View {
    let content: IngredientGroupContent

    var body: some View {
        Text(content.label.uppercased())
            .font(.caption.weight(.bold))
            .foregroundStyle(.secondary)
            .tracking(0.8)
            .padding(.top, 12)
    }
}

// MARK: - Ingredient Card

struct IngredientCardView: View {
    let content: IngredientContent
    let isInferred: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Quantity column
            Text(quantityText)
                .font(.body.monospacedDigit())
                .foregroundStyle(.primary)
                .frame(minWidth: 72, alignment: .leading)

            // Name column
            VStack(alignment: .leading, spacing: 2) {
                Text(content.name)
                    .font(.body)
                    .italic(isInferred)
                if let role = content.role {
                    Text(role)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            if isInferred {
                Text("✨")
                    .font(.caption2)
                    .opacity(0.5)
            }
        }
        .padding(.vertical, 4)
        .overlay(alignment: .bottom) {
            Divider().opacity(0.5)
        }
    }

    var quantityText: String {
        var parts: [String] = []
        if let q = content.quantity {
            parts.append(CardFormat.formatQuantity(q))
        }
        if let u = content.unit {
            parts.append(u)
        }
        return parts.joined(separator: " ")
    }
}

// MARK: - Optional Ingredients Card

struct OptionalIngredientsCardView: View {
    let content: OptionalIngredientsContent
    let isInferred: Bool
    @State private var expanded: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    expanded.toggle()
                }
            } label: {
                HStack {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(content.label ?? "Optional")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("(\(content.ingredients.count))")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(spacing: 0) {
                    ForEach(Array(content.ingredients.enumerated()), id: \.offset) { _, ing in
                        IngredientCardView(content: ing, isInferred: isInferred)
                    }
                }
                .padding(.leading, 8)
            }
        }
        .padding(12)
        .background(.fill.quinary)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    init(content: OptionalIngredientsContent, isInferred: Bool) {
        self.content = content
        self.isInferred = isInferred
        _expanded = State(initialValue: !(content.collapsed ?? true))
    }
}

// MARK: - Variation Chips Card

struct VariationChipsCardView: View {
    let content: VariationChipsContent

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("VARIATIONS")
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
                .tracking(0.8)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(content.variations, id: \.self) { v in
                        HStack(spacing: 6) {
                            Text(CardFormat.titleCase(v.label))
                                .font(.footnote.weight(.medium))
                            if let count = v.recipe_count {
                                Text("\(count)")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(.fill.tertiary)
                                    .clipShape(Capsule())
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(.fill.quaternary)
                        .clipShape(Capsule())
                    }
                }
            }
        }
    }
}

// MARK: - Equipment Card

struct EquipmentCardView: View {
    let content: EquipmentContent

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("EQUIPMENT")
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
                .tracking(0.8)
            if let req = content.required, !req.isEmpty {
                HStack(spacing: 6) {
                    ForEach(req, id: \.self) { item in
                        HStack(spacing: 4) {
                            Image(systemName: "wrench.and.screwdriver")
                                .font(.caption2)
                            Text(CardFormat.titleCase(item))
                                .font(.footnote)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.fill.quaternary)
                        .clipShape(Capsule())
                    }
                }
            }
        }
    }
}

// MARK: - Composition Header Card

struct CompositionHeaderCardView: View {
    let content: CompositionHeaderContent

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(content.composition.capitalized)
                .font(.system(size: 40, weight: .bold, design: .serif))
            Text(content.description)
                .font(.body)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Variant Set Carousel Card

struct VariantSetCarouselCardView: View {
    let content: VariantSetCarouselContent
    @State private var activeIndex: Int

    init(content: VariantSetCarouselContent) {
        self.content = content
        _activeIndex = State(initialValue: content.active_index)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("CHOOSE A STYLE")
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
                .tracking(0.8)

            TabView(selection: $activeIndex) {
                ForEach(Array(content.sets.enumerated()), id: \.offset) { idx, set in
                    variantSetPage(set: set)
                        .tag(idx)
                        .padding(.horizontal, 2)
                        .padding(.bottom, 28)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
            .indexViewStyle(.page(backgroundDisplayMode: .always))
            .frame(minHeight: 240)
        }
    }

    @ViewBuilder
    func variantSetPage(set: VariantSet) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(set.label)
                    .font(.title3.weight(.bold))
                Spacer()
                Text("\(set.recipe_count)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.fill.tertiary)
                    .clipShape(Capsule())
            }
            Text(set.cuisine.capitalized)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.red)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(.red.opacity(0.12))
                .clipShape(Capsule())

            Divider().opacity(0.5)

            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(set.slots.keys.sorted()), id: \.self) { slotName in
                    if let ings = set.slots[slotName], !ings.isEmpty {
                        HStack(alignment: .top, spacing: 8) {
                            Text(slotName.uppercased())
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.secondary)
                                .frame(width: 70, alignment: .leading)
                            Text(ings.prefix(3).map { $0.name }.joined(separator: ", "))
                                .font(.caption)
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                            Spacer()
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.fill.quinary)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Slot Card

struct SlotCardView: View {
    let content: SlotContent
    @State private var activeIndex: Int
    @State private var pinned: Bool

    init(content: SlotContent) {
        self.content = content
        _activeIndex = State(initialValue: content.active_variant_index)
        _pinned = State(initialValue: content.pinned)
    }

    var variants: [SlotVariant] { content.variants }

    var currentVariant: SlotVariant? {
        guard !variants.isEmpty else { return nil }
        let idx = max(0, min(activeIndex, variants.count - 1))
        return variants[idx]
    }

    var displayedIngredients: [VariantIngredient] {
        if !content.current.isEmpty && activeIndex == content.active_variant_index {
            return content.current
        }
        return currentVariant?.ingredients ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(content.slot_name.uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
                    .tracking(0.8)
                if content.required {
                    Text("required")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                Button {
                    pinned.toggle()
                } label: {
                    Image(systemName: pinned ? "pin.fill" : "pin")
                        .font(.footnote)
                        .foregroundStyle(pinned ? Color.orange : Color.secondary.opacity(0.5))
                }
                .buttonStyle(.plain)
            }

            TabView(selection: $activeIndex) {
                ForEach(Array(variants.enumerated()), id: \.offset) { idx, variant in
                    slotPage(variant: variant, useCurrent: idx == content.active_variant_index)
                        .tag(idx)
                        .padding(.bottom, 22)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: variants.count > 1 ? .always : .never))
            .indexViewStyle(.page(backgroundDisplayMode: .always))
            .frame(minHeight: 90)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(.fill.quinary)
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(pinned ? .orange.opacity(0.4) : .clear, lineWidth: 1.5)
                )
        )
    }

    @ViewBuilder
    func slotPage(variant: SlotVariant, useCurrent: Bool) -> some View {
        let ings: [VariantIngredient] = (useCurrent && !content.current.isEmpty) ? content.current : variant.ingredients
        VStack(alignment: .leading, spacing: 6) {
            if ings.isEmpty {
                Text("no suggestions")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
            } else {
                ForEach(ings.prefix(3), id: \.name) { ing in
                    HStack(spacing: 6) {
                        Text(ing.name)
                            .font(.body.weight(.medium))
                        Text("\(Int(ing.frequency * 100))%")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Spacer()
                    }
                }
            }
            Text(variant.cuisine.capitalized)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.red)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.red.opacity(0.12))
                .clipShape(Capsule())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Multi Slot Card

struct MultiSlotCardView: View {
    let content: MultiSlotContent
    @State private var activeIndex: Int = 0
    @State private var items: [VariantIngredient]

    init(content: MultiSlotContent) {
        self.content = content
        _items = State(initialValue: content.current_items)
    }

    var currentVariant: SlotVariant? {
        guard !content.variants.isEmpty else { return nil }
        let idx = max(0, min(activeIndex, content.variants.count - 1))
        return content.variants[idx]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(content.slot_name.uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
                    .tracking(0.8)
                Text("pick \(content.min_items)–\(content.max_items)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Spacer()
                if let v = currentVariant {
                    Text(v.cuisine.capitalized)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.red)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.red.opacity(0.12))
                        .clipShape(Capsule())
                }
            }

            // Current items list
            if items.isEmpty {
                Text("No items yet — swipe to pick a style")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .padding(.vertical, 4)
            } else {
                VStack(spacing: 4) {
                    ForEach(Array(items.enumerated()), id: \.offset) { idx, ing in
                        HStack {
                            Text(ing.name)
                                .font(.body)
                            Spacer()
                            Button {
                                items.remove(at: idx)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.tertiary)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.vertical, 4)
                        .overlay(alignment: .bottom) { Divider().opacity(0.4) }
                    }
                }
            }

            // Suggestions (swipable variants)
            TabView(selection: $activeIndex) {
                ForEach(Array(content.variants.enumerated()), id: \.offset) { idx, variant in
                    suggestionsRow(variant: variant)
                        .tag(idx)
                        .padding(.bottom, 22)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: content.variants.count > 1 ? .always : .never))
            .indexViewStyle(.page(backgroundDisplayMode: .always))
            .frame(minHeight: 80)
        }
        .padding(12)
        .background(.fill.quinary)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    func suggestionsRow(variant: SlotVariant) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("SUGGESTIONS — \(variant.label)")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.tertiary)
                .tracking(0.6)
            FlowLayout(spacing: 6) {
                ForEach(variant.ingredients.prefix(6), id: \.name) { ing in
                    Button {
                        addItem(ing)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "plus")
                                .font(.caption2.weight(.bold))
                            Text(ing.name)
                                .font(.caption)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(.fill.quaternary)
                        .clipShape(Capsule())
                        .foregroundStyle(.primary)
                    }
                    .buttonStyle(.plain)
                    .disabled(items.count >= content.max_items || items.contains(where: { $0.name == ing.name }))
                    .opacity((items.count >= content.max_items || items.contains(where: { $0.name == ing.name })) ? 0.4 : 1.0)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    func addItem(_ ing: VariantIngredient) {
        guard items.count < content.max_items else { return }
        guard !items.contains(where: { $0.name == ing.name }) else { return }
        items.append(ing)
    }
}

// MARK: - FlowLayout (simple wrap layout)

struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > maxW {
                x = 0
                y += rowH + spacing
                rowH = 0
            }
            x += sz.width + spacing
            rowH = max(rowH, sz.height)
        }
        return CGSize(width: maxW == .infinity ? x : maxW, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let maxW = bounds.width
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > maxW {
                x = 0
                y += rowH + spacing
                rowH = 0
            }
            s.place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + y), proposal: ProposedViewSize(sz))
            x += sz.width + spacing
            rowH = max(rowH, sz.height)
        }
    }
}

// MARK: - Template Stream View

struct TemplateStreamView: View {
    let compositionName: String

    @State private var template: CompositionTemplate?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Loading template...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage {
                ContentUnavailableView(
                    "Couldn't load template",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage)
                )
            } else if let template {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        ForEach(template.stream) { card in
                            CardDispatchView(card: card)
                                .padding(.horizontal, 20)
                        }
                    }
                    .padding(.vertical, 16)
                }
            }
        }
        .navigationTitle("Build \(compositionName.capitalized)")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    func load() async {
        isLoading = true
        errorMessage = nil
        do {
            template = try await SpenceAPI.fetchCompositionTemplate(name: compositionName)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: - Card Dispatch (shared)

struct CardDispatchView: View {
    let card: Card

    var body: some View {
        switch card.content {
        case .title(let c):
            TitleCardView(content: c, isInferred: card.isInferred)
        case .canonicalBadge(let c):
            CanonicalBadgeCardView(content: c)
        case .tagChips(let c):
            TagChipsCardView(content: c)
        case .time(let c):
            TimeCardView(content: c, isInferred: card.isInferred)
        case .yield(let c):
            YieldCardView(content: c, isInferred: card.isInferred)
        case .ingredientGroup(let c):
            IngredientGroupCardView(content: c)
        case .ingredient(let c):
            IngredientCardView(content: c, isInferred: card.isInferred)
        case .optionalIngredients(let c):
            OptionalIngredientsCardView(content: c, isInferred: card.isInferred)
        case .variationChips(let c):
            VariationChipsCardView(content: c)
        case .equipment(let c):
            EquipmentCardView(content: c)
        case .compositionHeader(let c):
            CompositionHeaderCardView(content: c)
        case .variantSetCarousel(let c):
            VariantSetCarouselCardView(content: c)
        case .slot(let c):
            SlotCardView(content: c)
        case .multiSlot(let c):
            MultiSlotCardView(content: c)
        case .unknown(let type):
            UnknownCardView(type: type)
        }
    }
}

// MARK: - Composition Picker

struct CompositionPickerView: View {
    @Environment(\.dismiss) var dismiss
    @State private var selected: BuilderComposition?

    let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(BuilderComposition.allCases) { comp in
                        Button {
                            selected = comp
                        } label: {
                            VStack(spacing: 8) {
                                Text(comp.emoji)
                                    .font(.system(size: 48))
                                Text(comp.displayName)
                                    .font(.headline)
                                    .foregroundStyle(.primary)
                            }
                            .frame(maxWidth: .infinity)
                            .frame(height: 130)
                            .background(.fill.quinary)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(16)
            }
            .navigationTitle("What are you making?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
            .navigationDestination(item: $selected) { comp in
                TemplateStreamView(compositionName: comp.rawValue)
            }
        }
    }
}

// MARK: - Unknown Card

struct UnknownCardView: View {
    let type: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "questionmark.square.dashed")
                .font(.caption)
            Text("Unsupported card: \(type)")
                .font(.caption)
        }
        .foregroundStyle(.tertiary)
        .padding(8)
        .background(.fill.quinary)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}
