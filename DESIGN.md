---
name: Awaken IQ
colors:
  surface: '#f7f9fb'
  surface-dim: '#d8dadc'
  surface-bright: '#f7f9fb'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f4f6'
  surface-container: '#eceef0'
  surface-container-high: '#e6e8ea'
  surface-container-highest: '#e0e3e5'
  on-surface: '#191c1e'
  on-surface-variant: '#414944'
  inverse-surface: '#2d3133'
  inverse-on-surface: '#eff1f3'
  outline: '#717974'
  outline-variant: '#c0c9c2'
  surface-tint: '#386754'
  primary: '#386754'
  on-primary: '#ffffff'
  primary-container: '#bbeed5'
  on-primary-container: '#3f6e5a'
  inverse-primary: '#9fd1b9'
  secondary: '#68558b'
  on-secondary: '#ffffff'
  secondary-container: '#d5bffd'
  on-secondary-container: '#5d4b80'
  tertiary: '#6b4ab2'
  on-tertiary: '#ffffff'
  tertiary-container: '#eaddff'
  on-tertiary-container: '#7151b8'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#bbeed5'
  primary-fixed-dim: '#9fd1b9'
  on-primary-fixed: '#002115'
  on-primary-fixed-variant: '#1f4f3d'
  secondary-fixed: '#ebddff'
  secondary-fixed-dim: '#d2bcfa'
  on-secondary-fixed: '#231043'
  on-secondary-fixed-variant: '#4f3d72'
  tertiary-fixed: '#eaddff'
  tertiary-fixed-dim: '#d1bcff'
  on-tertiary-fixed: '#24005b'
  on-tertiary-fixed-variant: '#523198'
  background: '#f7f9fb'
  on-background: '#191c1e'
  surface-variant: '#e0e3e5'
typography:
  display-lg:
    fontFamily: literata
    fontSize: 56px
    fontWeight: '700'
    lineHeight: 64px
    letterSpacing: -0.02em
  display-lg-mobile:
    fontFamily: literata
    fontSize: 40px
    fontWeight: '700'
    lineHeight: 48px
    letterSpacing: -0.01em
  headline-lg:
    fontFamily: literata
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
  headline-md:
    fontFamily: literata
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  body-lg:
    fontFamily: raleway
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: raleway
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-lg:
    fontFamily: raleway
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.05em
  label-md:
    fontFamily: raleway
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 8px
  container-max: 1280px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 64px
  section-gap: 120px
---

## Brand & Style

The design system is crafted for a premium educational and child-development platform that balances academic rigor with a nurturing, wellness-focused atmosphere. The brand personality is **inspiring and trustworthy**, aiming to evoke a sense of professional excellence while remaining approachable for families. 

The visual style employs a **Sophisticated Glassmorphism** aesthetic. It leverages translucent layers, soft background blurs, and airy whitespace to create a "modern SaaS" feel that is rare in the traditional education sector. This approach signals innovation and transparency. The UI feels light and breathable, yet grounded by high-contrast accents that provide a sense of authority and stability.

## Colors

The palette is anchored by a soft, professional **Mint Teal** primary color, chosen to represent growth, calm, and clarity. This is contrasted sharply with a **Deep Royal Purple**, used for footers, primary calls-to-action, and authoritative headers to signify the premium, institutional quality of the platform.

- **Primary (Mint Teal):** Used for large surface areas, highlights, and subtle background tints.
- **Secondary (Deep Purple):** Reserved for high-contrast moments, grounding the design and providing a sense of luxury and depth.
- **Tertiary (Amethyst):** A bridge between the green and purple, used for interactive states and decorative accents.
- **Surface:** A crisp, neutral white background ensures the glassmorphism effects and soft shadows maintain their "lifting" effect without looking muddy.

## Typography

The typographic hierarchy uses a "Modern Academic" pairing. **Literata** (Headline) provides an authoritative, literary feel that resonates with educational excellence and storytelling. Its thick strokes and warm serifs ensure the brand feels premium rather than sterile.

**Raleway** (Body) offers a clean, geometric contrast. It is highly legible for instructional content while its unique character (especially the 'w') maintains a friendly, contemporary vibe suitable for child-development contexts. 

Use **Display** sizes for hero sections and key marketing claims. **Labels** should be used for small metadata, tags, and eyebrow headlines to maintain a structured, organized information hierarchy.

## Layout & Spacing

The layout follows a **Fixed-Fluid Hybrid Grid**. The central content area is capped at 1280px to ensure readability, while decorative background elements and glassmorphic panels may bleed to the edges of the viewport.

- **Grid:** A 12-column grid is used for desktop, 8 for tablet, and 4 for mobile. 
- **Rhythm:** An 8px base unit governs all padding and margins. 
- **Sectioning:** Large vertical gaps (120px+) are used between major content blocks to emphasize a premium, "un-cluttered" user experience.
- **Mobile Adaptation:** Side margins compress to 16px, and multi-column card layouts reflow into a single-column stack to maintain large touch targets.

## Elevation & Depth

Hierarchy is achieved through **Tonal Stacking and Glassmorphism**. Instead of traditional dark shadows, this design system uses:

1.  **Level 0 (Base):** Solid white background.
2.  **Level 1 (Surface):** Subtle light-grey or mint-tinted fills for large sections.
3.  **Level 2 (Glass Cards):** Translucent white fills (`rgba(255, 255, 255, 0.7)`) with a `blur(20px)` backdrop filter. These cards feature a thin, 1px semi-transparent white border to simulate the edge of glass.
4.  **Floating Elements:** Interactive elements (like buttons or active cards) use a **Soft Glow Shadow**—a diffuse, low-opacity shadow tinted with the primary Mint Teal or Secondary Purple, rather than pure black. This creates a sense of light and vibrance.

## Shapes

The shape language is defined by **generous, friendly curves**. 

Standard UI components like buttons and input fields use a medium radius (0.5rem), while the signature **Glass Cards** and containers utilize larger radii (1rem to 1.5rem). This softens the "tech" feel of the SaaS aesthetic, making the platform feel safe, welcoming, and child-friendly. Buttons may occasionally use a fully pill-shaped profile for a more playful, modern interaction.

## Components

### Buttons
- **Primary:** Deep Purple background with White text. High contrast for clear direction. Pill-shaped.
- **Secondary:** Mint Teal background with Deep Purple text. Used for secondary actions.
- **Ghost:** Transparent background with a 1.5px Deep Purple border.

### Cards
All cards must implement the glassmorphism effect. They should have a 24px internal padding and 16px-24px corner radius. On hover, cards should subtly scale (1.02x) and the shadow intensity should increase to indicate interactivity.

### Input Fields
Inputs are clean with a soft grey border that transitions to Mint Teal on focus. Use a 12px rounded corner. The label should always sit above the field in **Label-LG** typography.

### Chips & Tags
Used for categorizing subjects (e.g., "Mathematics," "Emotional IQ"). These should be small, pill-shaped, and use the Primary Mint Teal at 20% opacity with a darker version of the teal for the text.

### Progress Indicators
For a child-development platform, progress bars should be thick (8px+) with rounded caps, using a gradient transition from Mint Teal to Amethyst to signify achievement and delight.