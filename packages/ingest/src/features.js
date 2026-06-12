// Per-stage interactive features. A stage carries which of these are ON; when
// it goes live the admin sets the active set here, and the ingest's behaviours
// consult getFeature() at their trigger points. Default: everything on — so a
// stage with no features block (and the pre-stage default) behaves exactly as
// the ingest always has.
//
// These gate INGEST-side behaviours (votes, recognition, welcomes, popups,
// ambient effects), which is why they live here and not in the scene: switching
// stages re-shapes the interaction layer, not just the picture.

export const FEATURE_KEYS = ["votes", "superchats", "effects", "welcome", "popups", "directives", "automations"];
export const FEATURE_LABELS = {
  votes: "Theme voting",
  superchats: "Superchat cards",
  effects: "Ambient effects",
  welcome: "Welcome messages",
  popups: "Emoji reactions",
  directives: "Chat shoutout cards",
  automations: "Custom automations",
};

const allOn = () => Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
let active = allOn();

// normalize ANY input (partial object, or undefined) to a full key→bool map,
// defaulting each key to ON unless explicitly false
export function normalizeFeatures(f) {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, f && typeof f === "object" ? f[k] !== false : true]));
}

export function setActiveFeatures(f) { active = normalizeFeatures(f); }
export function getFeature(name) { return active[name] !== false; }
export function activeFeatures() { return { ...active }; }
