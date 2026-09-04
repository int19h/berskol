# Collaboration

The Herdr Collab project ID for this repository is exactly `berskol`. Select it explicitly with `herdr-collab --project berskol ...` or `HERDR_COLLAB_PROJECT=berskol`; a checkout path or current working directory never selects a project.

When a task directs you to collaborate through Herdr Collab, use `herdr-collab agent spawn` to create a visible Herdr-hosted collaborator; it injects the selected project and reserved session identity into the native environment. `herdr-collab session join` only registers a participant identity that was started manually; that participant must export and use the returned identity as its own `HERDR_COLLAB_SESSION`. Spawned sessions receive this variable automatically. Never reuse another session's identity. Herdr Collab supplies coordination transport, not project process: it imposes no roles, work items, models, review order, turn order, or write boundaries. The task prompt and applicable repository guidance define those choices.

Use durable mail for decisions and handoffs. `send` starts durable correspondence, `reply` answers it, `show <id>` reads the selected message body, `show <id> --json` exposes the full selected record, and `ack` records an addressed recipient's explicit disposition. Neither `show` form traverses ancestor messages, so follow references explicitly. A reply or acknowledgement records disposition only; it does not by itself mean agreement, completion, or acceptance. Live agent prompts are transient wakeups and never replace durable mail or count as disposition.

Inspect `herdr-collab inbox --pending` and `herdr-collab status` at natural task or turn boundaries where coordination matters, especially before a handoff or completion claim. Do not turn this into forced polling or a standing wait. Use a finite foreground `herdr-collab wait --timeout ...` only when the current task calls for it.

Never hand-edit Herdr Collab's external state. Use the CLI for projects, sessions, groups, messages, replies, and acknowledgements.

## Resumable pauses

Before an anticipated long pause, first persist every load-bearing decision, exact revision, path, unresolved finding, and open question in durable mail or a handoff file. Compact native context only when requested, before that pause, and while the context is still likely cached. After compaction, verify the stored and live native identity with `herdr-collab session show "$HERDR_COLLAB_SESSION" --live`; refresh or adopt deliberately if identity cannot be verified, rather than guessing.

If an already-idle session later presents a cache-expired choice, inspect that exact dialog and default to continuing the full existing context. Never answer a blocked trust, permission, or other dialog without explicit authority.
