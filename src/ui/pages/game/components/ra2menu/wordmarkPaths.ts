// Independently drawn faceted, short-serif lettering for the RED ALERT 2 title.
// RED ALERT shares the upper baseline; the numeral occupies the lower center support.
// The game title stays separate from the client domain.
export const WORDMARK_GLYPHS = {
  D: 'M0 0H27L43 8L49 20V36L43 48L27 56H0V49H4V7H0Z M15 10V46H25L34 40L37 32V24L34 16L25 10Z',
  L: 'M0 0H20V7H15V46H35V40H43V56H0V49H4V7H0Z',
  T: 'M0 0H48V17H39V10H30V49H35V56H13V49H18V10H9V17H0Z',
  R: 'M0 0H30L44 6L48 15V24L40 32H31L43 49H49V56H32L18 34H15V49H20V56H0V49H4V7H0Z M15 10V25H28L35 21V14L28 10Z',
  A: 'M15 0H34V7H31L45 49H49V56H30V49H34L31 40H17L14 49H19V56H0V49H4L18 7H15Z M20 30H28L24 16Z',
  '2': 'M1 15V9L11 0H36L48 10V23L39 32L16 45H36V40H48V56H0V43L31 25L35 21V14L30 10H19L14 14V19H1Z',
  E: 'M0 0H47V15H39V10H15V23H34V19H42V37H34V33H15V46H39V41H47V56H0V49H4V7H0Z',
} as const;
export const WORDMARK_LETTERS = [
  { glyph: 'R', x: 98, y: 200, sx: 0.99, sy: 0.75 },
  { glyph: 'E', x: 149, y: 200, sx: 0.99, sy: 0.75 },
  { glyph: 'D', x: 198, y: 200, sx: 0.99, sy: 0.75 },
  { glyph: 'A', x: 284, y: 200, sx: 0.99, sy: 0.75 },
  { glyph: 'L', x: 335, y: 200, sx: 0.99, sy: 0.75 },
  { glyph: 'E', x: 380, y: 200, sx: 0.99, sy: 0.75 },
  { glyph: 'R', x: 429, y: 200, sx: 0.99, sy: 0.75 },
  { glyph: 'T', x: 480, y: 200, sx: 0.99, sy: 0.75 },
  { glyph: '2', x: 276, y: 252, sx: 1.32, sy: 0.77 },
] as const;
