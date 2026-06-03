# director (Phase 2 — not yet built)

The Claude-driven brain of the stream. Consumes **moderated** comment/payment
events from `ingest/`, arbitrates competing requests (cooldowns, voting,
fairness), and emits **validated scene directives** — the same
`{action, params}` shape the Phase 0 `streamer` already accepts via `/mutate`.

Hard rule (already enforced in `streamer`): the Director never emits HTML or
code. Viewer input can only become *arguments* to the pre-vetted SceneAPI
actions. New visual capabilities are added by extending the SceneAPI + template
library, not by widening what untrusted input can express.
