// Intro music: the songs that play UNDER the "starting shortly" landing screen
// (live.sh intro / STANDBY_ON_BOOT=true) — a pre-show loop with its own vibe,
// separate from the house ROTATION. The DJ loops these while in "intro" mode and
// switches to the live queue/rotation when the operator goes on air
// (live.sh onair → 10s on-screen countdown → live queue). These are the
// operator's OWN Suno tracks; the DJ resolves them to playable audio on boot.
export const INTRO = [
  "https://suno.com/s/fNYf1MRadeA379Xw",
  "https://suno.com/s/oWCRHhqjh82JnPoq",
];
