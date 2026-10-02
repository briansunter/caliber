# Caliber design system

Caliber is a quiet personal reading space: warm ivory surfaces, forest green actions, charcoal text, and an editorial bookshelf. Dark reader canvases retain their low-distraction controls.

## Visual direction

- Background: warm paper (`#f8f7f3`) with white control and settings surfaces.
- Ink: charcoal (`#242923`) for clear, readable text.
- Accent: forest green (`#285a48`) for selected navigation, actions, links, and focus rings.
- Display typography: system Georgia for the welcome headline and book detail titles. UI text uses the system sans-serif stack. No network font request is required.
- Shape: restrained 6–12px rounding, light borders, and subtle cover shadows. Books sit on an open shelf rather than inside dashboard cards.
- Missing covers use a deterministic muted palette and title treatment. Compact list thumbnails use initials, including non-Latin titles.

## Tokens

The source of truth is `styles/globals.css`.

```css
:root {
  --bg: #f8f7f3;
  --bg-elevated: #ffffff;
  --bg-muted: #f0eee7;
  --bg-subtle: #e9e6dc;
  --text: #242923;
  --text-secondary: #565e53;
  --text-tertiary: #73796d;
  --text-muted: #858b7f;
  --accent: #285a48;
  --accent-hover: #1e4738;
}
```

Use semantic classes such as `bg-surface`, `bg-parchment`, `text-ink`, and `border-ink`. Reader overlays may use translucent white controls on their dark canvas.

## Layout

- Desktop library navigation occupies a 232px sidebar. Mobile uses a compact header with the same profile and settings controls.
- The main content is capped at 1500px. A welcome section and simple library counts lead into the bookshelf.
- The toolbar wraps on small screens. Its actual height determines the sticky list header offset.
- Grid and list views use window virtualization. Covers reserve a 2:3 aspect ratio; grid layout derives from the actual container width. Compact list rows are 56px; comfortable rows are 72px.
- Recent books use small horizontal cards with saved progress and a working Undo action even after removing the final item.
- URL parameters preserve search, view, sorting, tags, and formats. Grid is the default. Scroll anchors are scoped to the query, view, user, and library.

## Interaction and accessibility

- Every icon-only control has an accessible name and visible keyboard focus.
- Search supports composition input, debouncing, Enter, and clearing. Changing URL state cancels older pending searches.
- Filters expose selected counts and removable chips. Dialogs support Escape, focus trapping, and focus return; mobile sheets lock background scrolling.
- Loading, empty, offline, and error states distinguish their causes. Recoverable failures include a retry control.
- Failed facet requests display an error instead of claiming that the library has no tags or formats.
- Profile and library changes clear stale data and prevent pending operations from restoring another shelf.
- Cover URLs include library identity so switching libraries cannot reuse old artwork.
- Reduced-motion preferences remove animation and transitions.

## Readers

EPUB, PDF, and comic readers use explicit back, page, zoom, load-mode, and settings controls. Hidden chrome is inert. Position input is committed on Enter or blur and reverted on Escape. Only successfully displayed pages update reading progress. Corrupt saved positions are validated; stale locations can recover without a complete book reload. Streaming EPUB mode does not load every chapter just to calculate progress.

Arrow keys and Space turn pages without scrolling the next page; Shift+Space goes back. Browser shortcuts and text composition retain their normal behavior. If a reader fails to load, its recovery screen offers reload or return to the library.
