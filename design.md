# Caliber design system

Caliber is a quiet, paper-like library surface: the catalogue stays bright and readable, while ink-black branding and indigo actions provide a clear visual spine. Reader screens intentionally switch to dark, low-distraction controls.

## Visual direction

- **Surface:** cool paper background (`#fafafa`) with white elevated cards and a barely visible paper texture.
- **Ink:** near-black text and controls for high contrast and a strong brand mark.
- **Accent:** indigo for links, focus rings, selected filters, ratings, and primary actions.
- **Shape:** restrained 6–14px rounding, thin ink borders, and small shadows that distinguish surfaces without making the catalogue feel like a dashboard.
- **Signature detail:** the repeating paper texture and centered ornamental footer divider establish the library feel without decorative noise.

## Tokens

The source of truth is `styles/globals.css`.

```css
:root {
  --bg: #fafafa;
  --bg-elevated: #ffffff;
  --bg-muted: #f5f5f5;
  --bg-subtle: #f0f0f0;
  --text: #171717;
  --text-secondary: #525252;
  --text-tertiary: #737373;
  --text-muted: #a3a3a3;
  --accent: #4f46e5;
  --accent-hover: #4338ca;
  --border-default: rgba(0, 0, 0, 0.08);
}
```

Use semantic classes such as `bg-surface`, `bg-parchment`, `text-ink`, `text-ink-secondary`, and `border-ink`. Avoid adding literal white catalogue surfaces; reader overlays may use translucent white controls on their dark canvas.

## Layout

- The home page uses one responsive content column capped at `max-w-7xl`.
- Search, filters, and view controls remain visible in a sticky toolbar.
- List and grid views use virtual scrolling and should keep their row/card geometry stable.
- Cards and table sections are elevated surfaces with borders, so they remain distinct from the paper background on small and large screens.
- Detail and Settings routes provide a `#main-content` landmark and a keyboard-visible skip link is available from the root layout.

## Typography

Inter is the primary UI font with system fallbacks. Titles use a compact semibold hierarchy; metadata is smaller and muted. Long titles and author names must truncate or wrap safely rather than overflow controls.

## Interaction and accessibility

- Every icon-only control has an accessible label and a visible focus ring.
- Search and settings inputs have labels or accessible names, stable IDs, and useful autocomplete semantics.
- Async loading/error messages use ellipsis and live regions where appropriate; errors include a retry action when the request can be retried.
- Cover images reserve their aspect ratio and fall back to deterministic initials if a Calibre cover is missing or fails to load.
- `prefers-reduced-motion` removes animation and transitions.
- Reader toolbars are dark by design; catalogue surfaces must preserve contrast between `bg-surface`, `bg-parchment`, borders, and text.

## Reader screens

EPUB, PDF, and comic readers use a dark canvas with translucent controls. Reader content is sandboxed where possible, streamed through bounded endpoints, and uses explicit back, zoom, page, load-mode, and settings labels. Do not reuse the dark reader palette for catalogue pages.
