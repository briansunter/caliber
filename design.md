# Calibre Library - Design System

## Direction: Dark Academia

### Rationale

A digital library should feel like a library. Not a spreadsheet, not a dashboard—a sanctuary for readers. Dark Academia evokes the romance of old university libraries: leather-bound books, brass reading lamps, worn wooden desks, the smell of parchment and possibility. This aesthetic transforms the mundane task of managing e-books into an experience that honors the written word.

The darkness serves a practical purpose too—it's easy on the eyes during long reading sessions and makes book covers pop with vibrant color against the moody backdrop.

---

## Color Palette

```css
:root {
  /* Core Backgrounds */
  --bg-primary: #0D0F0A;        /* Deep forest black - main background */
  --bg-secondary: #141610;       /* Slightly lifted black - cards, panels */
  --bg-tertiary: #1A1C15;        /* Elevated surfaces - hover states */
  --bg-elevated: #22251C;        /* Highest elevation - modals, dropdowns */

  /* Accent Colors - Aged Gold & Leather */
  --accent-gold: #C9A227;        /* Aged brass gold - primary actions */
  --accent-gold-dim: #9A7B1A;    /* Deeper gold - hover states */
  --accent-gold-bright: #E5C84B; /* Bright gold - highlights */
  --accent-copper: #B87333;      /* Aged copper - secondary accent */
  --accent-burgundy: #722F37;    /* Deep wine - special states */

  /* Text Colors */
  --text-primary: #F5F1E8;       /* Aged parchment white */
  --text-secondary: #A8A495;     /* Faded ink - muted text */
  --text-tertiary: #6B6554;      /* Ghost text - disabled, placeholders */

  /* Semantic Colors */
  --success: #4A6741;            /* Deep moss green */
  --warning: #8B6914;            /* Aged amber */
  --error: #8B2635;              /* Deep crimson */
  --info: #4A5D6A;               /* Dusty blue */

  /* Borders & Dividers */
  --border-subtle: #2A2D24;      /* Barely visible borders */
  --border-default: #3A3D32;     /* Standard borders */
  --border-accent: #4A4D40;      /* Emphasized borders */

  /* Special Effects */
  --shadow-gold: rgba(201, 162, 39, 0.15);
  --shadow-deep: rgba(0, 0, 0, 0.6);
  --glow-gold: rgba(201, 162, 39, 0.3);
}
```

---

## Typography

### Font Families

```css
:root {
  /* Headlines & Display - Distinctive serif with character */
  --font-display: 'Crimson Pro', 'Crimson Text', Georgia, serif;

  /* Body Text - Readable, warm serif */
  --font-body: 'Source Serif 4', 'Source Serif Pro', Georgia, serif;

  /* UI Elements - Elegant sans-serif for buttons, labels */
  --font-ui: 'Josefin Sans', 'Futura', sans-serif;
}
```

### Type Scale

```css
:root {
  /* Display - Book titles, hero text */
  --text-hero: 3rem;        /* 48px - Featured book title */
  --text-display: 2.25rem;  /* 36px - Page titles */
  --text-headline: 1.5rem;  /* 24px - Section headers */

  /* Body */
  --text-large: 1.125rem;   /* 18px - Lead paragraphs */
  --text-base: 1rem;        /* 16px - Body text */
  --text-small: 0.875rem;   /* 14px - Secondary text */
  --text-xs: 0.75rem;       /* 12px - Captions, metadata */

  /* Line Heights */
  --leading-tight: 1.2;
  --leading-normal: 1.6;
  --leading-relaxed: 1.8;
}
```

### Font Loading

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;500;600;700&family=Josefin+Sans:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&display=swap" rel="stylesheet">
```

---

## Layout Approach

### Grid System

- **12-column grid** with generous gutters (24px)
- **Max container width**: 1400px for main content
- **Sidebar width**: 280px fixed, collapsible to 64px
- **Spacing scale**: 4px base unit (4, 8, 12, 16, 24, 32, 48, 64, 96)

### Key Layout Principles

1. **Asymmetrical balance** - Sidebar on left, main content breathing room
2. **Generous margins** - Books need space; cramming disrespects them
3. **Layered depth** - Subtle shadows create the feeling of stacked volumes
4. **Reading focus** - Content area centered, distractions minimized

### Z-Index Scale

```css
:root {
  --z-base: 0;
  --z-elevated: 10;
  --z-dropdown: 100;
  --z-sticky: 200;
  --z-modal: 300;
  --z-tooltip: 400;
  --z-toast: 500;
}
```

---

## Key Visual Elements

### Textures

1. **Paper texture overlay** - Subtle noise at 3% opacity on backgrounds
2. **Leather grain** - Used on sidebar and premium elements
3. **Deckled edges** - Book cover placeholders have rough, torn-paper edges

### Patterns

1. **Marbled endpaper** - Used in empty states and decorative headers
2. **Blind emboss** - Subtle pattern for inactive states
3. **Gold filigree** - Decorative corner accents on featured books

### Effects

```css
/* Gold shimmer on hover for interactive elements */
@keyframes gold-shimmer {
  0% { background-position: -200% center; }
  100% { background-position: 200% center; }
}

/* Subtle page turn animation */
@keyframes page-turn {
  0% { transform: rotateY(0deg); }
  100% { transform: rotateY(-15deg); }
}

/* Reading lamp glow */
.reading-glow {
  box-shadow:
    0 0 60px var(--shadow-gold),
    0 0 100px var(--shadow-gold);
}

/* Book spine effect */
.book-spine {
  background: linear-gradient(
    90deg,
    rgba(255,255,255,0.05) 0%,
    transparent 10%,
    transparent 90%,
    rgba(0,0,0,0.3) 100%
  );
}
```

### Decorative Elements

- **Ornamental dividers** - Small fleuron (❧) or decorative lines between sections
- **Corner brackets** - Subtle gold brackets on featured cards
- **Wax seal** - Used for "verified" or "favorite" indicators
- **Ribbon bookmarks** - Visual indicator for currently reading

---

## Animation Philosophy

### Principles

1. **Dignified, not flashy** - Animations should feel like turning a page, not a carnival
2. **Purposeful motion** - Every animation guides the eye or confirms an action
3. **Respectful timing** - 300-500ms for most transitions, never instantaneous, never sluggish

### Standard Transitions

```css
:root {
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in-out-sine: cubic-bezier(0.37, 0, 0.63, 1);
  --duration-fast: 150ms;
  --duration-normal: 300ms;
  --duration-slow: 500ms;
}
```

### Specific Animations

| Element | Animation | Duration | Easing |
|---------|-----------|----------|--------|
| Button hover | Background color + subtle lift | 200ms | ease-out-expo |
| Card hover | Scale 1.02 + shadow deepen | 300ms | ease-out-expo |
| Modal open | Fade in + scale from 0.95 | 400ms | ease-out-expo |
| Page transition | Fade + subtle slide up | 400ms | ease-in-out-sine |
| Book cover load | Fade in + slight rotate | 500ms | ease-out-expo |
| Sidebar toggle | Slide + content shift | 400ms | ease-in-out-sine |
| Toast notification | Slide in from right | 300ms | ease-out-expo |
| Focus ring | Gold glow pulse | 200ms | ease-out |

### Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## Component Styling

### Button

**Primary Button (Gold)**

```css
.btn-primary {
  /* Layout */
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  border-radius: 2px;

  /* Typography */
  font-family: var(--font-ui);
  font-size: var(--text-small);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;

  /* Colors */
  background: var(--accent-gold);
  color: var(--bg-primary);
  border: none;

  /* Effects */
  transition: all 200ms var(--ease-out-expo);
  position: relative;
  overflow: hidden;
}

.btn-primary::before {
  /* Subtle shimmer effect */
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255,255,255,0.2),
    transparent
  );
  transform: translateX(-100%);
}

.btn-primary:hover {
  background: var(--accent-gold-bright);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px var(--shadow-gold);
}

.btn-primary:hover::before {
  animation: gold-shimmer 1s ease;
}

.btn-primary:active {
  transform: translateY(0);
}
```

**Secondary Button (Ghost)**

```css
.btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  border-radius: 2px;

  font-family: var(--font-ui);
  font-size: var(--text-small);
  font-weight: 500;
  letter-spacing: 0.05em;
  text-transform: uppercase;

  background: transparent;
  color: var(--text-primary);
  border: 1px solid var(--border-default);

  transition: all 200ms var(--ease-out-expo);
}

.btn-secondary:hover {
  border-color: var(--accent-gold);
  color: var(--accent-gold);
  background: rgba(201, 162, 39, 0.05);
}
```

### Book Card

```css
.book-card {
  /* Layout */
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
  border-radius: 4px;

  /* Colors */
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);

  /* Effects */
  transition: all 300ms var(--ease-out-expo);
  position: relative;
}

.book-card::before {
  /* Subtle top highlight */
  content: '';
  position: absolute;
  top: 0;
  left: 1rem;
  right: 1rem;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255,255,255,0.1),
    transparent
  );
}

.book-card:hover {
  transform: translateY(-4px) scale(1.01);
  border-color: var(--border-accent);
  box-shadow:
    0 8px 24px var(--shadow-deep),
    0 0 0 1px var(--border-accent);
}

.book-cover {
  aspect-ratio: 2/3;
  border-radius: 2px;
  overflow: hidden;
  position: relative;
  box-shadow:
    0 4px 6px rgba(0,0,0,0.3),
    0 10px 20px rgba(0,0,0,0.4);
}

.book-cover::after {
  /* Spine highlight */
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 8px;
  background: linear-gradient(
    90deg,
    rgba(255,255,255,0.1),
    transparent
  );
}

.book-title {
  font-family: var(--font-display);
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--text-primary);
  line-height: var(--leading-tight);

  /* Limit to 2 lines */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.book-author {
  font-family: var(--font-body);
  font-size: var(--text-small);
  color: var(--text-secondary);
  font-style: italic;
}

.book-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
```

### Sidebar Navigation

```css
.sidebar {
  width: 280px;
  height: 100vh;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-subtle);
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.nav-section {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.nav-section-title {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-tertiary);
  padding: 0 0.75rem;
  margin-bottom: 0.5rem;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border-radius: 4px;

  font-family: var(--font-body);
  font-size: var(--text-small);
  color: var(--text-secondary);

  transition: all 200ms var(--ease-out-expo);
  cursor: pointer;
}

.nav-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.nav-item.active {
  background: rgba(201, 162, 39, 0.1);
  color: var(--accent-gold);
}

.nav-item.active::before {
  /* Gold accent line */
  content: '';
  position: absolute;
  left: 0;
  width: 3px;
  height: 1.5rem;
  background: var(--accent-gold);
  border-radius: 0 2px 2px 0;
}
```

### Search Input

```css
.search-input {
  width: 100%;
  padding: 0.75rem 1rem 0.75rem 2.5rem;
  border-radius: 4px;

  font-family: var(--font-body);
  font-size: var(--text-small);
  color: var(--text-primary);

  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);

  transition: all 200ms var(--ease-out-expo);
}

.search-input:focus {
  outline: none;
  border-color: var(--accent-gold);
  box-shadow: 0 0 0 3px rgba(201, 162, 39, 0.1);
}

.search-input::placeholder {
  color: var(--text-tertiary);
}

.search-icon {
  position: absolute;
  left: 0.875rem;
  color: var(--text-tertiary);
}
```

---

## Usage Examples

### Complete Page Structure

```html
<div class="app">
  <aside class="sidebar">
    <div class="logo">
      <span class="logo-icon">📚</span>
      <span class="logo-text">Caliber</span>
    </div>
    <nav class="nav-section">
      <span class="nav-section-title">Library</span>
      <a class="nav-item active">All Books</a>
      <a class="nav-item">Currently Reading</a>
      <a class="nav-item">Favorites</a>
      <a class="nav-item">Want to Read</a>
    </nav>
  </aside>

  <main class="main-content">
    <header class="page-header">
      <h1 class="page-title">All Books</h1>
      <div class="search-wrapper">
        <span class="search-icon">🔍</span>
        <input class="search-input" placeholder="Search your library...">
      </div>
    </header>

    <div class="book-grid">
      <article class="book-card">
        <div class="book-cover">
          <img src="cover.jpg" alt="Book cover">
        </div>
        <div class="book-info">
          <h3 class="book-title">The Secret History</h3>
          <p class="book-author">Donna Tartt</p>
          <div class="book-meta">
            <span> Fiction</span>
            <span>•</span>
            <span>1992</span>
          </div>
        </div>
      </article>
    </div>
  </main>
</div>
```

---

## Implementation Notes

1. **CSS Custom Properties** - All values use CSS variables for easy theming
2. **Dark Mode Only** - This is intentionally a dark-first design
3. **Accessibility** - Gold on dark maintains WCAG AA contrast ratios
4. **Performance** - Use `transform` and `opacity` for animations only
5. **Print Styles** - Not applicable for this desktop app context
