# Design Task: Redesign Chat Interface

Redesign the existing chat interface into a polished, production-quality conversational UI inspired by the current ChatGPT desktop experience.

The goal is NOT to clone ChatGPT exactly. Use the screenshot as visual reference for the overall interaction model, spacing, hierarchy, proportions, and minimal aesthetic, while keeping the product's own identity.

## 1. Overall Layout

Use a two-column desktop layout:

- Fixed left sidebar: approximately 360px wide.
- Main chat area: fills the remaining viewport.
- Full viewport height.
- No unnecessary borders or visual clutter.
- Dark theme by default.

The interface should feel spacious, calm, premium, and highly focused on the conversation.

## 2. Sidebar

Create a persistent left navigation sidebar with:

- Product/logo area at the top.
- A prominent "New chat" button.
- Primary navigation items underneath.
- A projects/workspace section.
- Scrollable conversation/project list.
- User profile section anchored at the bottom.

The sidebar should use subtle tonal differences rather than heavy borders.

Use:
- Dark near-black background.
- Slightly lighter surfaces for interactive elements.
- Rounded buttons and navigation items.
- Clear hover states.
- Compact but comfortable vertical spacing.

The "New chat" action should be visually prominent without looking like a traditional bright CTA.

## 3. Main Chat Area

The main area should be extremely minimal.

When there is no active conversation:

- Center the empty-state content horizontally and vertically around the upper-middle portion of the viewport.
- Show a short welcoming heading.
- Place the chat composer directly underneath.
- Avoid unnecessary illustrations or decorative graphics.

When a conversation exists:

- Messages should occupy a centered content column.
- Keep the conversation width readable rather than stretching across the entire screen.
- User and assistant messages should have clear but subtle visual distinction.
- Preserve generous horizontal padding.

## 4. Chat Composer

Make the composer the primary interaction element.

It should be:

- Large and horizontally centered.
- Rounded with a substantial corner radius.
- Dark elevated surface against the background.
- Comfortable internal padding.
- Multi-line capable.
- Visually similar to a modern AI chat composer.

Include controls inside/below the composer such as:

- Attachment/add button.
- Model/reasoning selector.
- Voice input button.
- Send button.

The send button should be a circular button positioned at the lower-right of the composer.

The composer should visually feel like a single cohesive component rather than a normal form input.

## 5. Typography

Use a clean modern sans-serif font.

Typography should be:

- Highly legible.
- Medium-weight for headings.
- Regular-weight for body text.
- Tight but comfortable line heights.
- Subtle hierarchy rather than excessive font-size variation.

Avoid oversized marketing-style typography.

## 6. Color System

Use a restrained dark palette:

- Near-black page background.
- Slightly lighter sidebar.
- Dark gray elevated surfaces.
- Soft gray secondary text.
- Near-white primary text.
- One restrained accent color for interactive elements.

Avoid gradients, excessive glow, glassmorphism, or neon effects.

The overall appearance should feel sophisticated and functional.

## 7. Interaction Design

Add polished states for:

- Sidebar item hover.
- New chat hover/active state.
- Composer focus.
- Buttons.
- Send button.
- Navigation selection.
- Message actions.

Animations should be subtle and fast.

Prefer:
- opacity transitions
- small background-color transitions
- subtle scale changes
- smooth composer focus states

Do not use flashy animations.

## 8. Responsive Behavior

On smaller screens:

- Collapse the sidebar into a drawer.
- Keep the composer fixed/accessible near the bottom.
- Reduce horizontal padding.
- Preserve comfortable touch targets.
- Ensure the conversation remains readable without horizontal scrolling.

## 9. Visual Principles

The final design should communicate:

- Minimal
- Premium
- Calm
- Technical
- Extremely usable
- Conversation-first

Prioritize hierarchy, spacing, alignment, and interaction quality over decoration.

Use the provided screenshot as the primary visual reference for the composition and proportions, but do not reproduce ChatGPT branding, logos, exact text, or proprietary visual assets.

The result should feel like a thoughtfully designed AI assistant product that belongs to its own brand, while using the same general interaction patterns that make modern AI chat interfaces effective.
