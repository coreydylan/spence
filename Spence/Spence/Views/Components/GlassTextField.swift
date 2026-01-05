//
//  GlassTextField.swift
//  Spence
//
//  Glass input field with frosted background
//

import SwiftUI

/// A text field with frosted glass styling and focus state animations
///
/// Features:
/// - Frosted glass background
/// - Animated border highlight on focus
/// - Placeholder text support
/// - Leading icon support
/// - Multiline support
/// - Clear button option
///
/// Usage:
/// ```swift
/// @State private var text = ""
///
/// GlassTextField(
///     "Search recipes...",
///     text: $text,
///     icon: "magnifyingglass"
/// )
/// ```
struct GlassTextField: View {
    let placeholder: String
    @Binding var text: String
    let icon: String?
    let multiline: Bool
    let showClearButton: Bool

    @FocusState private var isFocused: Bool
    @State private var showClear = false

    /// Creates a glass text field
    ///
    /// - Parameters:
    ///   - placeholder: Placeholder text
    ///   - text: Binding to text value
    ///   - icon: Optional SF Symbol name for leading icon
    ///   - multiline: Enable multiline text editing (default: false)
    ///   - showClearButton: Show clear button when text is not empty (default: true)
    init(
        _ placeholder: String,
        text: Binding<String>,
        icon: String? = nil,
        multiline: Bool = false,
        showClearButton: Bool = true
    ) {
        self.placeholder = placeholder
        self._text = text
        self.icon = icon
        self.multiline = multiline
        self.showClearButton = showClearButton
    }

    var body: some View {
        HStack(spacing: 12) {
            // Leading icon
            if let icon {
                Image(systemName: icon)
                    .foregroundStyle(isFocused ? Color.spenceOrange : Color.textTertiary)
                    .font(.body)
                    .frame(width: 20)
            }

            // Text input
            if multiline {
                textEditor
            } else {
                textField
            }

            // Clear button
            if showClearButton && !text.isEmpty {
                Button {
                    text = ""
                    let impact = UIImpactFeedbackGenerator(style: .light)
                    impact.impactOccurred()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Color.textTertiary)
                        .font(.body)
                }
                .transition(.scale.combined(with: .opacity))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, multiline ? 16 : 14)
        .background(
            ZStack {
                // Glass background
                RoundedRectangle(cornerRadius: 16)
                    .fill(.ultraThinMaterial)

                RoundedRectangle(cornerRadius: 16)
                    .fill(Color.glassMedium)

                // Subtle inner gradient
                RoundedRectangle(cornerRadius: 16)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.08),
                                Color.clear
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(
                    isFocused ? Color.spenceOrange : Color.glassBorder,
                    lineWidth: isFocused ? 2 : 1
                )
        )
        .shadow(
            color: isFocused ? Color.spenceOrange.opacity(0.2) : Color.glassShadow.opacity(0.1),
            radius: isFocused ? 12 : 8,
            x: 0,
            y: isFocused ? 6 : 4
        )
        .animation(.easeInOut(duration: 0.2), value: isFocused)
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: text.isEmpty)
    }

    private var textField: some View {
        TextField(placeholder, text: $text)
            .foregroundStyle(Color.textPrimary)
            .tint(Color.spenceOrange)
            .focused($isFocused)
            .submitLabel(.done)
    }

    private var textEditor: some View {
        ZStack(alignment: .topLeading) {
            // Placeholder
            if text.isEmpty {
                Text(placeholder)
                    .foregroundStyle(Color.textTertiary)
                    .padding(.top, 8)
            }

            // Text editor with fixed height
            TextEditor(text: $text)
                .foregroundStyle(Color.textPrimary)
                .tint(Color.spenceOrange)
                .focused($isFocused)
                .scrollContentBackground(.hidden)
                .background(Color.clear)
                .frame(minHeight: 100, maxHeight: 200)
        }
    }
}

// MARK: - Secure Field Variant

/// A secure text field with glass styling for password input
struct GlassSecureField: View {
    let placeholder: String
    @Binding var text: String
    let icon: String?

    @FocusState private var isFocused: Bool
    @State private var isSecured = true

    init(
        _ placeholder: String,
        text: Binding<String>,
        icon: String? = "lock.fill"
    ) {
        self.placeholder = placeholder
        self._text = text
        self.icon = icon
    }

    var body: some View {
        HStack(spacing: 12) {
            // Leading icon
            if let icon {
                Image(systemName: icon)
                    .foregroundStyle(isFocused ? Color.spenceOrange : Color.textTertiary)
                    .font(.body)
                    .frame(width: 20)
            }

            // Text input
            if isSecured {
                SecureField(placeholder, text: $text)
                    .foregroundStyle(Color.textPrimary)
                    .tint(Color.spenceOrange)
                    .focused($isFocused)
            } else {
                TextField(placeholder, text: $text)
                    .foregroundStyle(Color.textPrimary)
                    .tint(Color.spenceOrange)
                    .focused($isFocused)
            }

            // Show/hide button
            Button {
                isSecured.toggle()
                let impact = UIImpactFeedbackGenerator(style: .light)
                impact.impactOccurred()
            } label: {
                Image(systemName: isSecured ? "eye.slash.fill" : "eye.fill")
                    .foregroundStyle(Color.textTertiary)
                    .font(.body)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 16)
                    .fill(.ultraThinMaterial)

                RoundedRectangle(cornerRadius: 16)
                    .fill(Color.glassMedium)
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(
                    isFocused ? Color.spenceOrange : Color.glassBorder,
                    lineWidth: isFocused ? 2 : 1
                )
        )
        .shadow(
            color: isFocused ? Color.spenceOrange.opacity(0.2) : Color.glassShadow.opacity(0.1),
            radius: isFocused ? 12 : 8,
            x: 0,
            y: isFocused ? 6 : 4
        )
        .animation(.easeInOut(duration: 0.2), value: isFocused)
    }
}

// MARK: - Previews

#Preview("Text Field Variants") {
    @Previewable @State var searchText = ""
    @Previewable @State var recipeText = ""
    @Previewable @State var notesText = ""
    @Previewable @State var password = ""

    ZStack {
        AmbientBackground()

        ScrollView {
            VStack(spacing: 24) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Search Field")
                        .font(.headline)
                        .foregroundStyle(Color.textSecondary)

                    GlassTextField(
                        "Search recipes...",
                        text: $searchText,
                        icon: "magnifyingglass"
                    )
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text("Recipe Name")
                        .font(.headline)
                        .foregroundStyle(Color.textSecondary)

                    GlassTextField(
                        "Enter recipe name",
                        text: $recipeText,
                        icon: "fork.knife"
                    )
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text("Notes (Multiline)")
                        .font(.headline)
                        .foregroundStyle(Color.textSecondary)

                    GlassTextField(
                        "Add cooking notes or substitutions...",
                        text: $notesText,
                        icon: "note.text",
                        multiline: true
                    )
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text("Password Field")
                        .font(.headline)
                        .foregroundStyle(Color.textSecondary)

                    GlassSecureField(
                        "Enter password",
                        text: $password
                    )
                }
            }
            .padding()
        }
    }
}

#Preview("Form Example") {
    @Previewable @State var recipeName = ""
    @Previewable @State var servings = ""
    @Previewable @State var cookTime = ""
    @Previewable @State var notes = ""

    ZStack {
        AmbientBackground()

        ScrollView {
            GlassCard {
                VStack(alignment: .leading, spacing: 20) {
                    Text("New Recipe")
                        .font(.title)
                        .fontWeight(.bold)
                        .foregroundStyle(Color.textPrimary)

                    VStack(spacing: 16) {
                        GlassTextField(
                            "Recipe name",
                            text: $recipeName,
                            icon: "fork.knife"
                        )

                        HStack(spacing: 12) {
                            GlassTextField(
                                "Servings",
                                text: $servings,
                                icon: "person.2",
                                showClearButton: false
                            )

                            GlassTextField(
                                "Cook time",
                                text: $cookTime,
                                icon: "timer",
                                showClearButton: false
                            )
                        }

                        GlassTextField(
                            "Add notes...",
                            text: $notes,
                            icon: "note.text",
                            multiline: true
                        )
                    }

                    GlassButton.primary("Create Recipe", systemImage: "plus") {
                        print("Create recipe")
                    }
                }
                .padding()
            }
            .padding()
        }
    }
}

#Preview("Interactive States") {
    @Previewable @State var text1 = ""
    @Previewable @State var text2 = "Some existing text"
    @Previewable @State var text3 = ""

    ZStack {
        AmbientBackground()

        VStack(spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Empty State")
                    .font(.caption)
                    .foregroundStyle(Color.textTertiary)
                GlassTextField("Type something...", text: $text1, icon: "pencil")
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("With Text (Clear Button)")
                    .font(.caption)
                    .foregroundStyle(Color.textTertiary)
                GlassTextField("Type something...", text: $text2, icon: "pencil")
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("No Icon")
                    .font(.caption)
                    .foregroundStyle(Color.textTertiary)
                GlassTextField("Just text field...", text: $text3)
            }

            Text("Tap to focus and see border highlight")
                .font(.caption)
                .foregroundStyle(Color.textTertiary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}

#Preview("Search Interface") {
    @Previewable @State var searchQuery = ""

    ZStack {
        AmbientBackground()

        VStack(spacing: 0) {
            // Search bar
            VStack(spacing: 16) {
                GlassTextField(
                    "Search recipes, ingredients...",
                    text: $searchQuery,
                    icon: "magnifyingglass"
                )

                // Filter chips
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(["All", "Quick", "Dinner", "Italian", "Vegetarian"], id: \.self) { filter in
                            Text(filter)
                                .font(.subheadline)
                                .foregroundStyle(Color.textSecondary)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 8)
                                .background(Color.glassLight)
                                .cornerRadius(20)
                        }
                    }
                }
            }
            .padding()
            .background(Color.spenceBackground.opacity(0.95))

            Spacer()
        }
    }
}
