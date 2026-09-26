// Presence, not state. The console never decides who may do what: it reads the resolved
// permissions the server sent and renders an element only when the answer is 'allow'.
// There is no role-to-permission table anywhere under web/.

export const allows = (permissions, key) => permissions?.[key]?.effect === 'allow';

// The attributes a present, permission-gated element carries. An element that is not
// allowed is not rendered at all — there is no 'locked' or disabled variant.
export const gate = (permission) => ({ 'data-permission': permission, 'data-state': 'unlocked' });

// Per-org identity. Known theme names get a hand-picked accent; any other theme string in
// the database still gets a stable colour of its own, derived from the name.
const KNOWN = {
  cobalt: 220, amber: 38, moss: 110, plum: 290, rust: 14, teal: 175,
};

export function themeColours(theme) {
  let hue = KNOWN[theme];
  if (hue === undefined) {
    hue = 0;
    for (const ch of String(theme)) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  }
  return {
    accent: `hsl(${hue} 65% 45%)`,
    ink: `hsl(${hue} 70% 22%)`,
    tint: `hsl(${hue} 45% 96%)`,
  };
}
