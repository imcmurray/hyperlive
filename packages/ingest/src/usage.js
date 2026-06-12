// Process-wide tally of outbound Anthropic API calls (director + moderation +
// mood + card authoring), surfaced in the dashboard header so the operator can
// see at a glance how hard we're leaning on the model this session. Counted at
// request time — i.e. how many times we hit the API. (Vision judging runs in
// the streamer process and is not included here.)
let anthropicCalls = 0;

export function bumpAnthropic() { anthropicCalls += 1; return anthropicCalls; }
export function anthropicCalls_() { return anthropicCalls; }
