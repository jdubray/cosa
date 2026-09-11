# COSA — architecture

A headless agent that watches a restaurant POS appliance around the clock and lets its owner operate it entirely by email.

Analysed at [`097de38`](https://github.com/jdubray/cosa/tree/097de38a346158f76e61b7b02618414bd09a1bf9).

**Read from.** src/main.js (code); src/orchestrator.js (code); src/cron-scheduler.js (code); src/email-gateway.js (code); src/session-store.js (code); README.md (document).

> Generated from the analysis by archlens. Edit the analysis, never this file.

## What this architecture answers

### How an email becomes an action

**The operator sends a plain-text email. What happens between that and a reply?**

COSA has no dashboard, no mobile app and no port anyone can connect to. The operator is a restaurant owner, not an engineer, and the only interface they have is the inbox they already read. That single decision shapes the whole front end: every request arrives as free-form prose from a person who has no idea what a tool or a role is, and every answer has to come back as a plain reply. The question is what sits between those two, and how much of it is decided before any model is asked anything at all.

The gateway polls IMAP every 60 seconds and keyword-routes first: approvals, suppressions and HOME-IP updates never reach the agent. What is left is classified as question or command, and that answer picks the role — which picks the model, the budget, the iteration cap, and the tools the session is even shown.

[Open the diagram](q_email.architecture.html) — 7 components.

| Component | Responsibility |
|---|---|
| **Operator** | Asks COSA questions, approves or denies risky actions, and describes new monitoring conditions — all in plain-text email. |
| **Gmail (IMAP/SMTP)** | Carries every message between COSA and the operator; COSA has no dashboard, app, or inbound port. |
| **Email gateway** | Polls the inbox every 60 seconds and routes each unseen message by keyword to the approval engine, a suppression handler, the home-IP updater, or a new agent session. |
| **Intent classifier** | Decides whether an inbound email is a read-only question or a request to change something, and fails toward the action role when ambiguous. |
| **Home-IP updater** | Rewrites the operator's home entry in the appliance's merchant-IP allowlist directly from a keyword email, bypassing the agent loop. |
| **Approval engine** | Emails the operator a one-time token for any non-read action and holds the tool call until they approve, deny, or the request expires. |
| **Orchestrator** | Runs one session as a SAM instance — call Claude, accept the response, dispatch tools, repeat until a terminal state — and picks the model, token budget, and iteration cap from the session's role. |

**Deliberately not shown.** The Claude API call itself, the guard pipeline, and the session internals — each has its own question.

#### The long read

Start at the left. The operator writes an ordinary email — "why is the card reader slow", or "restart the printer service" — and sends it to the address COSA watches. Nothing is pushed to COSA; it finds the message itself, because the mail gateway polls IMAP once a minute. That poll interval is the system's real latency floor: nothing COSA does in response to an email can be faster than roughly a minute.

The first thing the gateway does is look for keywords, and this is the step most readers underestimate. Three kinds of message never reach the agent at all. A reply carrying an approval token goes straight to the approval engine, because the whole point of an approval is that the model does not get to interpret it. A suppression request is handled as configuration. A HOME-IP message updates the network allowlist directly. These are deterministic routes: cheap, unambiguous, and immune to a model misreading them.

What is left is prose, and prose has to be classified. A cheap Haiku call decides whether the message is a question (read something and tell me) or a command (change something). That single answer is worth more than it looks, because in COSA the classification picks the role, and the role picks everything else at once: which model runs the turns, how many output tokens it gets, how many iterations it may take, which persona it speaks with, and — the part that matters for safety — which tools the session is even shown. A question becomes a read-only query session that has no mutating tool in its vocabulary.

Note which way the classifier fails. When it cannot tell confidently, it does not guess "question"; it routes to the action agent. That sounds like the unsafe direction until you remember what the action agent can do that a query agent cannot: read broader state, and ask the operator for confirmation. The conservative choice here is the more capable one, because capability includes the ability to stop and ask.

From there the orchestrator runs the session to a terminal state — that is the next diagram — and the final text is mailed back as a reply on the original thread. The operator sees a conversation. Underneath it, a role was chosen, a tool set was fenced off, and a full audit row was written before the first token was generated.

#### Terms used here

- **appliance** — The restaurant point-of-sale machine COSA watches: a separate computer on the cafe LAN running the merchant application, its database, and a receipt printer. COSA never runs on it; it reaches it over SSH and LAN HTTP.
- **SAM** — State-Action-Model: a loop that alternates proposing an action, accepting or rejecting it against the current model, and computing the next state. In COSA one agent session is one SAM instance, so a turn can only move the session to a status the machine allows.
- **session** — One run of the agent from a trigger (an email, a cron tick, a typed CLI line) to a terminal status. It has a role, a model, a token budget, an iteration cap, and a row in session.db holding every turn and tool call it made.
- **role** — The permission and cost profile a session is started with. The role picks the model, the token budget, the iteration cap, the persona, and — most importantly — which tools the session is allowed to run at all.
- **tool call** — A request from the model to run one named function with structured arguments — read a log, restart a service, call an appliance endpoint. COSA answers each one with a result the model sees on its next turn.
- **approval token** — A one-time code mailed to the operator when a session wants to run a risky tool. The tool stays blocked until the operator replies APPROVE with that code, and the code expires; a DENY or an expiry ends the attempt.
- **watcher** — A small operator-described predicate — "alert me if disk is over 85%" — evaluated against each appliance status snapshot. Watchers are stored rather than compiled, and run inside a sandbox because the operator wrote them.
- **IMAP / SMTP** — The two standard mail protocols. IMAP is how COSA reads the operator inbox, polled once a minute; SMTP is how it sends. Together they are the whole user interface — COSA opens no port of its own.
- **allowlist** — A closed list of what is permitted, where anything not named is refused. COSA allowlists the appliance HTTP endpoints it may call; an endpoint absent from the list is rated high risk rather than quietly allowed.
- **Haiku / Sonnet** — Two Claude models at different cost and capability points. COSA runs reasoning turns on the larger model and pushes the cheap mechanical work — classifying an email, compressing a transcript, grading a session — onto the smaller one.

### Inside one session

**What actually happens inside a single agent session, turn by turn?**

Once a trigger has decided what kind of session to run, that session is an agent loop: ask the model, run the tools it asks for, feed the results back, repeat until it produces a final answer. Loops like this fail in two characteristic ways — they run forever, and they outgrow their context window. COSA answers both structurally rather than by hoping the model behaves, and this diagram is about those two guards and where they sit.

A session is one SAM instance. Its prompt is assembled from the role persona, operator memory, and the compact skill index; then the loop alternates between calling Claude and dispatching the tools it asks for. Two guards sit on the loop itself: an FSM that rejects an illegal status transition and forces the session into an error state rather than letting it hang, and a compressor that replaces the middle of a long conversation with a Haiku summary while keeping the first and last turns intact. Every turn and tool call lands in session.db as it goes.

[Open the diagram](q_loop.architecture.html) — 7 components.

| Component | Responsibility |
|---|---|
| **CLI REPL** | Dispatches typed lines as sessions for local development, with email polling and cron disabled. |
| **Orchestrator** | Runs one session as a SAM instance — call Claude, accept the response, dispatch tools, repeat until a terminal state — and picks the model, token budget, and iteration cap from the session's role. |
| **Session FSM** | Rejects illegal session-lifecycle transitions and forces the session into an error state rather than letting it drift. |
| **Context builder** | Assembles the system prompt for a session from the role persona, the appliance identity file, operator memory, and the compact skill index. |
| **Context compressor** | Replaces the middle of a long conversation with a Haiku-written summary once message size crosses a threshold, keeping the first and last turns intact. |
| **Claude API** | Runs every agent turn, and separately does the cheap work — intent classification, context compression, session judging, skill drafting — on Haiku. |
| **Session store** | Persists every session, turn, tool call, approval, alert, watcher, and dead letter, with full-text search across the whole conversation history. |

**Deliberately not shown.** The guard pipeline around each tool call, and everything after the session closes.

#### The long read

A session can start from three places — a classified email, a scheduled cron task, or a line typed at the CLI — and from the orchestrator's point of view they are the same thing: a trigger plus a role. Everything downstream reads the role, not the trigger.

Before the first API call, the context builder assembles the system prompt from three sources: the persona for this role, the operator memory document (what COSA has been told and has learned about this particular restaurant), and a compact index of skills — one line each, enough for the model to know a procedure exists and ask for it. The full skill text is not pasted in; that would spend the context window on procedures the session will never use.

Then the loop turns. Each iteration calls Claude with the conversation so far and the tool schemas the role permits, and if the response contains tool calls, they are dispatched (through the guard pipeline in the next diagram) and their results appended as the next message. If it contains no tool calls, that is the final answer and the session closes.

Two guards ride on the loop itself. The first is the session FSM. Every status change — running, compressing, awaiting approval, complete, error — has to be accepted by a state machine before it is applied. This is the SAM pattern doing real work: an illegal transition is not silently absorbed, it is rejected, and the session is driven to an explicit error state. The failure mode being designed out here is a session that hangs in an undefined status forever, holding a lock and telling nobody. A hard iteration cap sits alongside it — twenty turns for operator work, ten for the audit role — and hitting it terminates the session with a stated reason rather than a silence.

The second guard is the context compressor. Before every API call, the message array is measured; if it is over threshold, Haiku is asked to summarize the middle of the conversation, and the compressed array replaces the live one. The first turns and the last turns survive intact, because those are the ones that carry the objective and the current working state — it is the long middle of retried commands and dumped logs that compresses without loss. Compression is itself a session status, so it too passes the acceptor rather than mutating the model behind its back.

Everything lands in session.db as it happens, not at the end: the session row, each turn, each tool call and its result. A session that crashes mid-flight still leaves a complete record up to the crash, which is the only reason the post-session judging and the audit trail can be trusted at all.

#### Terms used here

- **appliance** — The restaurant point-of-sale machine COSA watches: a separate computer on the cafe LAN running the merchant application, its database, and a receipt printer. COSA never runs on it; it reaches it over SSH and LAN HTTP.
- **SAM** — State-Action-Model: a loop that alternates proposing an action, accepting or rejecting it against the current model, and computing the next state. In COSA one agent session is one SAM instance, so a turn can only move the session to a status the machine allows.
- **FSM** — Finite state machine. A table of legal transitions between named states; an illegal transition is rejected rather than silently applied. COSA uses one for session status, one for security incidents, and one for the skill-creation lifecycle.
- **session** — One run of the agent from a trigger (an email, a cron tick, a typed CLI line) to a terminal status. It has a role, a model, a token budget, an iteration cap, and a row in session.db holding every turn and tool call it made.
- **role** — The permission and cost profile a session is started with. The role picks the model, the token budget, the iteration cap, the persona, and — most importantly — which tools the session is allowed to run at all.
- **tool call** — A request from the model to run one named function with structured arguments — read a log, restart a service, call an appliance endpoint. COSA answers each one with a result the model sees on its next turn.
- **watcher** — A small operator-described predicate — "alert me if disk is over 85%" — evaluated against each appliance status snapshot. Watchers are stored rather than compiled, and run inside a sandbox because the operator wrote them.
- **skill** — A short written procedure COSA keeps in skills.db and lists compactly in every system prompt, so a later session can recall how a past problem was solved. Some are seeded; the rest COSA writes itself after a session the judge graded as resolved.
- **FTS5** — SQLite full-text search. COSA indexes every session turn with it, so past incidents can be searched by wording rather than only by id or date.
- **redaction** — Stripping secrets — tokens, keys, passwords — out of text. COSA redacts tool output before writing it to the database, not merely before showing it to the model, so a leaked secret never lands in the audit trail.
- **Haiku / Sonnet** — Two Claude models at different cost and capability points. COSA runs reasoning turns on the larger model and pushes the cheap mechanical work — classifying an email, compressing a transcript, grading a session — onto the smaller one.

### What stops a tool call doing damage

**Claude asks to run a tool. What has to happen before anything actually changes?**

This is the diagram to read if you only read one. COSA is an autonomous agent with SSH access to a machine that takes card payments in a working restaurant, and the model driving it is fallible by construction: it can hallucinate a tool that does not exist, or ask for one it was never offered. The security posture cannot rest on the model behaving. It rests on what happens between the model asking for a tool and anything actually changing — five stages, in a fixed order, that a tool call cannot skip.

Five stages in fixed order: the role gate refuses tools above the session risk ceiling even if the model hallucinated one; the security gate blocks dangerous argument patterns; the approval gate mails a one-time token and blocks; dispatch runs; output is sanitized before it is persisted, not merely before the model sees it.

[Open the diagram](q_guards.architecture.html) — 5 components.

| Component | Responsibility |
|---|---|
| **Orchestrator** | Runs one session as a SAM instance — call Claude, accept the response, dispatch tools, repeat until a terminal state — and picks the model, token budget, and iteration cap from the session's role. |
| **Tool registry** | Holds every tool's schema, risk level, and handler, and refuses at dispatch time any tool whose risk exceeds what the session's role may run. |
| **Security gate** | Blocks dangerous command patterns before a tool runs and strips credentials from its output before that output reaches the model or the database. |
| **Approval engine** | Emails the operator a one-time token for any non-read action and holds the tool call until they approve, deny, or the request expires. |
| **Tool handlers** | Implement every concrete capability COSA has — health checks, database reads, backups, patching, network and PCI audits, watcher management, runbook control. |

**Deliberately not shown.** The approval email round-trip to the operator, the audit rows written on the way through, and the post-action verification that follows.

#### The long read

The model has just emitted a tool call. Follow it through in order.

Stage one is the role gate, and it is the stage most systems get wrong. The session was already shown only the tools its role permits — but that filtering is a hint, not a control, because a model can name a tool it was never shown. So the registry re-checks at execution time, against the role, and refuses anything above the session's risk ceiling. This is why a read-only query session physically cannot restart a service: not because it was not told about the tool, but because the dispatch point refuses it. If the same check lived only in prompt construction, one hallucinated tool name would be enough.

Stage two is the security gate, which inspects the actual arguments for dangerous patterns — command shapes that should never run regardless of who asked. Role and risk are about authority; this stage is about content.

Stage three is approval. If the tool is rated risky, the session does not proceed: the approval engine mints a one-time token, mails it to the operator, and the session blocks awaiting a reply. An APPROVE with the matching code releases it; a DENY or an expiry ends the attempt. Note that risk ratings live in appliance.yaml rather than in code, and that an appliance endpoint absent from the allowlist is rated high risk rather than treated as unknown-and-therefore-fine. The unknown case fails toward asking a human.

Stage four is the dispatch itself — the only stage where anything changes.

Stage five is the output sanitizer, and the detail worth pausing on is where it sits. Tool output is redacted before it is written to session.db, not merely before it is shown to the model. Those are very different guarantees. Redacting only for the model leaves the secret sitting in the audit database forever, which converts the audit trail — the thing you built to be safe — into the largest secret store in the system. The security gate reads the credential store to know what strings to look for.

The ordering is the design. Authority is checked before content, content before a human, a human before the action, and the action before anything is written down.

#### Terms used here

- **appliance** — The restaurant point-of-sale machine COSA watches: a separate computer on the cafe LAN running the merchant application, its database, and a receipt printer. COSA never runs on it; it reaches it over SSH and LAN HTTP.
- **SAM** — State-Action-Model: a loop that alternates proposing an action, accepting or rejecting it against the current model, and computing the next state. In COSA one agent session is one SAM instance, so a turn can only move the session to a status the machine allows.
- **session** — One run of the agent from a trigger (an email, a cron tick, a typed CLI line) to a terminal status. It has a role, a model, a token budget, an iteration cap, and a row in session.db holding every turn and tool call it made.
- **role** — The permission and cost profile a session is started with. The role picks the model, the token budget, the iteration cap, the persona, and — most importantly — which tools the session is allowed to run at all.
- **tool call** — A request from the model to run one named function with structured arguments — read a log, restart a service, call an appliance endpoint. COSA answers each one with a result the model sees on its next turn.
- **approval token** — A one-time code mailed to the operator when a session wants to run a risky tool. The tool stays blocked until the operator replies APPROVE with that code, and the code expires; a DENY or an expiry ends the attempt.
- **runbook** — A stored, ordered procedure for a known fix: a list of steps, each a tool call, with a convergence contract between them. Replaying a runbook is how COSA repeats a fix it already knows without asking the model to re-derive it.
- **watcher** — A small operator-described predicate — "alert me if disk is over 85%" — evaluated against each appliance status snapshot. Watchers are stored rather than compiled, and run inside a sandbox because the operator wrote them.
- **allowlist** — A closed list of what is permitted, where anything not named is refused. COSA allowlists the appliance HTTP endpoints it may call; an endpoint absent from the list is rated high risk rather than quietly allowed.
- **redaction** — Stripping secrets — tokens, keys, passwords — out of text. COSA redacts tool output before writing it to the database, not merely before showing it to the model, so a leaked secret never lands in the audit trail.

### Proving the action actually worked

**A tool returned 200. How does COSA know the system is genuinely fixed?**

An agent that trusts its own tool results will confidently report a fix that did not happen. "systemctl restart" exits zero when the unit fails to come back; an HTTP 200 says the request was accepted, not that the state changed. COSA treats the return code as a claim and the probe as evidence, and it re-checks in two places: once inside the session while the model can still act on it, and once after the session has closed, when the question is whether the whole episode is worth learning from.

It does not trust the return code. Layer A re-probes live appliance state with a configured read-only check and appends the verdict to the tool result, so the model gets deterministic ground truth and can self-correct inside its remaining iterations. Layer B grades the closed session with a cheap Haiku reviewer that treats any re-probe verdict as ground truth; that verdict is persisted, gates skill authoring, and raises an alert when an action ran cleanly but fixed nothing.

[Open the diagram](q_verify.architecture.html) — 8 components.

| Component | Responsibility |
|---|---|
| **Orchestrator** | Runs one session as a SAM instance — call Claude, accept the response, dispatch tools, repeat until a terminal state — and picks the model, token budget, and iteration cap from the session's role. |
| **Action verifier** | Re-probes live appliance state after a mutating tool call and appends the verdict to the tool result, so the model gets deterministic ground truth on its next turn. |
| **appliance.yaml** | Declares everything appliance-specific — SSH target, host key, endpoint allowlist with risk ratings, verification policies — so no appliance knowledge is compiled into COSA. |
| **Post-session hook** | Runs after a session closes to update operator memory, invoke the judge, alert on a silently failed action, and draft a reusable skill from sessions that genuinely worked. |
| **Session judge** | Grades a closed action session as resolved, unresolved, or uncertain, treating any re-probe verdict in the transcript as ground truth. |
| **Claude API** | Runs every agent turn, and separately does the cheap work — intent classification, context compression, session judging, skill drafting — on Haiku. |
| **Session store** | Persists every session, turn, tool call, approval, alert, watcher, and dead letter, with full-text search across the whole conversation history. |
| **Skill store** | Holds seed and self-authored skill documents and serves the compact index that goes into every system prompt. |

**Deliberately not shown.** Runbook convergence checks, which reuse the same contract from a different entry point, and the skill-creation lifecycle the hook drives once a verdict is in.

#### The long read

Layer A runs inside the loop. When a tool that changed something returns, the action verifier looks up a verification policy for that tool in appliance.yaml — a convergence contract of tool, field and expected value — and runs a read-only probe to see what the appliance actually reports now. The verdict is appended to the tool result the model sees. That placement is the whole trick: the model gets deterministic ground truth back on its very next turn, while it still has iterations left, so a failed fix becomes something it can respond to rather than something it reports as a success. Probes are enforced read-only and bounded by attempt and wall-time limits, so verification can never itself become a second, unreviewed action.

Layer B runs after the session closes. The orchestrator fires the post-session hook and does not wait for it, so a slow judgement never delays the operator's reply. The hook hands the closed transcript to the session judge, which asks a cheap Haiku pass one question: was the stated objective actually met? The judge is explicitly told to treat any Layer A re-probe verdict as ground truth over the narrative in the transcript — a model that says "the service is healthy now" does not outrank a probe that says otherwise.

The verdict then does three things. It is persisted alongside the session, so the audit trail records not just what happened but whether it worked. It gates skill authoring: only a session graded genuinely resolved may become a reusable skill, which is what stops COSA from teaching itself a procedure that failed. And when an action ran cleanly but fixed nothing, it raises an unresolved-action alert to the operator — the specific case that would otherwise be invisible, because every individual step reported success.

One honest caveat, and it is on the diagram as a trade-off rather than buried: both layers are opt-in per appliance and ship dormant. They do nothing until a verification policy is configured. The mechanism is built; whether it is armed is a deployment fact, not an architectural one.

#### Terms used here

- **appliance** — The restaurant point-of-sale machine COSA watches: a separate computer on the cafe LAN running the merchant application, its database, and a receipt printer. COSA never runs on it; it reaches it over SSH and LAN HTTP.
- **SAM** — State-Action-Model: a loop that alternates proposing an action, accepting or rejecting it against the current model, and computing the next state. In COSA one agent session is one SAM instance, so a turn can only move the session to a status the machine allows.
- **session** — One run of the agent from a trigger (an email, a cron tick, a typed CLI line) to a terminal status. It has a role, a model, a token budget, an iteration cap, and a row in session.db holding every turn and tool call it made.
- **role** — The permission and cost profile a session is started with. The role picks the model, the token budget, the iteration cap, the persona, and — most importantly — which tools the session is allowed to run at all.
- **tool call** — A request from the model to run one named function with structured arguments — read a log, restart a service, call an appliance endpoint. COSA answers each one with a result the model sees on its next turn.
- **probe** — A read-only check that reads live state without changing it — an SSH command, a service status query, a scalar SQL read. Probes are what COSA trusts; a probe result is evidence, where a tool return code is only a claim.
- **convergence contract** — A triple of tool, field and expected value that says what "it worked" means for a given action. The action verifier and the runbook engine evaluate the same contract, so a step that reported success but changed nothing is caught in either path.
- **runbook** — A stored, ordered procedure for a known fix: a list of steps, each a tool call, with a convergence contract between them. Replaying a runbook is how COSA repeats a fix it already knows without asking the model to re-derive it.
- **watcher** — A small operator-described predicate — "alert me if disk is over 85%" — evaluated against each appliance status snapshot. Watchers are stored rather than compiled, and run inside a sandbox because the operator wrote them.
- **skill** — A short written procedure COSA keeps in skills.db and lists compactly in every system prompt, so a later session can recall how a past problem was solved. Some are seeded; the rest COSA writes itself after a session the judge graded as resolved.
- **judge** — A cheap second model pass that reads a closed session and grades whether the stated objective was actually met. It treats any re-probe verdict as ground truth over the transcript, and its verdict gates whether the session may become a skill.
- **FTS5** — SQLite full-text search. COSA indexes every session turn with it, so past incidents can be searched by wording rather than only by id or date.
- **host key pinning** — Recording the appliance SSH host key fingerprint in advance and refusing to connect if the machine that answers presents a different one. It turns a silent man-in-the-middle into a refused connection and a logged security event.
- **allowlist** — A closed list of what is permitted, where anything not named is refused. COSA allowlists the appliance HTTP endpoints it may call; an endpoint absent from the list is rated high risk rather than quietly allowed.
- **redaction** — Stripping secrets — tokens, keys, passwords — out of text. COSA redacts tool output before writing it to the database, not merely before showing it to the model, so a leaked secret never lands in the audit trail.
- **Haiku / Sonnet** — Two Claude models at different cost and capability points. COSA runs reasoning turns on the larger model and pushes the cheap mechanical work — classifying an email, compressing a transcript, grading a session — onto the smaller one.

### Noticing trouble unasked

**Nobody emailed anything. How does COSA find out something is wrong?**

Most of what COSA does happens when nobody has asked for anything. The restaurant is closed, the operator is asleep, and something on the appliance is drifting. This half of the system has no conversation to anchor it, so it has to decide for itself what is worth waking a person for — and it has to do that without a developer shipping new code every time the operator thinks of a new thing to watch.

The cron scheduler drives roughly thirty tasks under a mutex. Some run probe-role agent sessions; others call tools directly, fold the result into the appliance state machine, and alert on severity. Two extension points avoid new code entirely: watchers are operator-described predicates run in a sandbox on each status snapshot, and observation monitors are declared as data rows of probe, thresholds, and template.

[Open the diagram](q_unattended.architecture.html) — 8 components.

| Component | Responsibility |
|---|---|
| **Cron scheduler** | Fires the unattended workload on a schedule — health checks, backups, patching, audits, watcher evaluation, digests — under a mutex so two tasks never overlap. |
| **Watcher registry** | Stores operator-described monitoring predicates, runs each against every status snapshot, and suppresses repeat alerts for a cooldown window. |
| **Watcher sandbox worker** | Executes one watcher predicate against a cloned status snapshot inside a stripped vm context in a throwaway child process. |
| **Observation monitor** | Evaluates monitors declared as data rows — probe, params, thresholds, report template — so a new monitor needs no new code. |
| **Appliance state machine** | Folds probe results into one live picture of the appliance across health, resources, application, network, and security, and marks each dimension stale on its own clock. |
| **Security FSM** | Tracks an intrusion incident through its escalation states so repeated findings advance rather than re-alert. |
| **Anomaly classifier** | Reduces a set of findings to a single severity so a scheduled task knows whether to alert. |
| **Email gateway** | Polls the inbox every 60 seconds and routes each unseen message by keyword to the approval engine, a suppression handler, the home-IP updater, or a new agent session. |

**Deliberately not shown.** Probe-role agent sessions and the runbook remediation path, which have their own questions.

#### The long read

The cron scheduler is the clock for everything unattended: roughly thirty tasks on their own schedules, run under a mutex so two heavy probes never overlap and turn a health check into the outage it was looking for.

The tasks split into three kinds, and the split is the point of this diagram.

Some tasks start a probe-role agent session — cheap model, tight iteration cap, read-only tools — when the judgement genuinely needs reasoning. Others skip the model entirely: call a tool, fold the result into the appliance state machine, and alert if the severity warrants it. If a threshold answers the question, paying for a language model to read the threshold is waste.

The third kind is the interesting one, because it is how the system grows without being edited. Watchers are predicates the operator described in an email — "tell me if disk goes over eighty-five percent" — stored and then evaluated against every status snapshot. Since the operator wrote them, they run inside two nested boundaries: a fresh child process per invocation, and a restricted vm context inside that with no filesystem or network reach. Observation monitors take the same idea a step further: a monitor is a data row naming a read-only probe, its parameters, the numeric thresholds that make a result medium or high, and an email template. Adding one is a data edit. Neither mechanism requires a deploy, and that is what makes the monitoring set track what the restaurant actually cares about instead of what someone predicted a year ago.

Whatever noticed the problem, the output path converges. The anomaly classifier rolls individual findings into one graded severity. Repeat alerts for the same condition are suppressed for a cooldown window, so a fault that persists for a day does not produce a day of identical emails. Security-relevant findings escalate through the security FSM, which has its own incident lifecycle rather than being one more email. And the appliance state machine holds five dimensions of known state, each ageing on its own clock — ten minutes for health, four hours for security — so a fresh reading of one thing never makes a stale reading of another look current. Unknown is a state COSA can be in and report honestly, which is a good deal harder to build than it sounds.

#### Terms used here

- **appliance** — The restaurant point-of-sale machine COSA watches: a separate computer on the cafe LAN running the merchant application, its database, and a receipt printer. COSA never runs on it; it reaches it over SSH and LAN HTTP.
- **SAM** — State-Action-Model: a loop that alternates proposing an action, accepting or rejecting it against the current model, and computing the next state. In COSA one agent session is one SAM instance, so a turn can only move the session to a status the machine allows.
- **FSM** — Finite state machine. A table of legal transitions between named states; an illegal transition is rejected rather than silently applied. COSA uses one for session status, one for security incidents, and one for the skill-creation lifecycle.
- **session** — One run of the agent from a trigger (an email, a cron tick, a typed CLI line) to a terminal status. It has a role, a model, a token budget, an iteration cap, and a row in session.db holding every turn and tool call it made.
- **role** — The permission and cost profile a session is started with. The role picks the model, the token budget, the iteration cap, the persona, and — most importantly — which tools the session is allowed to run at all.
- **probe** — A read-only check that reads live state without changing it — an SSH command, a service status query, a scalar SQL read. Probes are what COSA trusts; a probe result is evidence, where a tool return code is only a claim.
- **runbook** — A stored, ordered procedure for a known fix: a list of steps, each a tool call, with a convergence contract between them. Replaying a runbook is how COSA repeats a fix it already knows without asking the model to re-derive it.
- **watcher** — A small operator-described predicate — "alert me if disk is over 85%" — evaluated against each appliance status snapshot. Watchers are stored rather than compiled, and run inside a sandbox because the operator wrote them.
- **observation monitor** — A monitoring rule expressed purely as data: which read-only probe to run, its parameters, the numeric thresholds that make a result medium or high severity, and the email template. Adding one is a data edit, not new code.
- **sandbox** — An isolated execution context for code COSA did not write. Watcher predicates get two nested layers: a fresh child process per invocation, and a restricted vm context inside it with no filesystem or network reach.
- **judge** — A cheap second model pass that reads a closed session and grades whether the stated objective was actually met. It treats any re-probe verdict as ground truth over the transcript, and its verdict gates whether the session may become a skill.
- **IMAP / SMTP** — The two standard mail protocols. IMAP is how COSA reads the operator inbox, polled once a minute; SMTP is how it sends. Together they are the whole user interface — COSA opens no port of its own.
- **staleness** — How old a piece of known state may be before it stops counting as known. Each dimension of the appliance state machine ages on its own clock, so a fresh health reading does not make a four-hour-old security reading look current.
- **cooldown** — A window after an alert during which the same condition will not be mailed again. It is what keeps a persistent fault from becoming an hourly inbox flood.

### What COSA remembers, and where

**What survives a session, and which store holds it?**

COSA is a long-lived process that keeps talking to the same person about the same machine for months. What it remembers is therefore load-bearing: it is the audit trail a payment system needs, the reason a session in September knows what happened in June, and the material COSA writes its own procedures from. Four stores hold it, and the interesting part is why they are four and not one.

Four stores with different jobs. session.db is the audit trail and also hosts the appliance-state and runbook tables, with FTS5 over every turn. skills.db holds seed and self-authored procedures and feeds the compact index in each prompt. The credential store is encrypted, lives outside the repository, and refuses to start without its key. Operator memory is a sectioned document folded into every system prompt.

[Open the diagram](q_state.architecture.html) — 6 components.

| Component | Responsibility |
|---|---|
| **Orchestrator** | Runs one session as a SAM instance — call Claude, accept the response, dispatch tools, repeat until a terminal state — and picks the model, token budget, and iteration cap from the session's role. |
| **Context builder** | Assembles the system prompt for a session from the role persona, the appliance identity file, operator memory, and the compact skill index. |
| **Session store** | Persists every session, turn, tool call, approval, alert, watcher, and dead letter, with full-text search across the whole conversation history. |
| **Skill store** | Holds seed and self-authored skill documents and serves the compact index that goes into every system prompt. |
| **Credential store** | Keeps appliance secrets encrypted outside the repository and refuses to start without its key. |
| **Memory manager** | Carries operator preferences and learned facts across sessions as a sectioned document folded into each system prompt. |

**Deliberately not shown.** The appliance state machine and runbook tables, which also live in session.db but are shown where they are used.

#### The long read

session.db is the record of everything that happened. Every session, every turn, every tool call, every approval and its outcome, every alert and every expiry — written as it occurs rather than at the end. FTS5 indexes the turns, so a later session can search past incidents by wording rather than by id. It also hosts the appliance-state and runbook tables, which is a pragmatic choice rather than a conceptual one: they live here because they share the same durability and backup story.

skills.db is different in kind. It holds procedures, some seeded and some COSA wrote for itself after a session the judge graded as resolved. Its job in the running system is to produce the compact index the context builder folds into every system prompt — one line per skill, enough for a model to know the procedure exists and ask for it. This is the loop that makes COSA cumulative: work that succeeded becomes a written procedure, and the procedure shows up in the next relevant prompt.

The credential store is deliberately not like the others. It is encrypted, it lives under the home directory outside the repository, and COSA refuses to start without its key. Two constraints follow that are easy to miss: nothing in the repo tree is a secret, so the repo can be cloned and read freely; and a COSA that cannot decrypt its credentials fails loudly at boot instead of running in a degraded state where half the probes silently fail. The security gate also reads it, because knowing what the secrets are is a prerequisite for redacting them out of tool output.

Operator memory is the fourth, and it is not a database at all — it is a sectioned document, folded into every system prompt. That shape is chosen for the same reason a runbook is text: a human has to be able to read it, correct it, and hand it to someone else. It carries what COSA has been told and what it has concluded about this specific restaurant, which is exactly the knowledge that would otherwise have to be re-derived from the transcript every session.

#### Terms used here

- **appliance** — The restaurant point-of-sale machine COSA watches: a separate computer on the cafe LAN running the merchant application, its database, and a receipt printer. COSA never runs on it; it reaches it over SSH and LAN HTTP.
- **SAM** — State-Action-Model: a loop that alternates proposing an action, accepting or rejecting it against the current model, and computing the next state. In COSA one agent session is one SAM instance, so a turn can only move the session to a status the machine allows.
- **FSM** — Finite state machine. A table of legal transitions between named states; an illegal transition is rejected rather than silently applied. COSA uses one for session status, one for security incidents, and one for the skill-creation lifecycle.
- **session** — One run of the agent from a trigger (an email, a cron tick, a typed CLI line) to a terminal status. It has a role, a model, a token budget, an iteration cap, and a row in session.db holding every turn and tool call it made.
- **role** — The permission and cost profile a session is started with. The role picks the model, the token budget, the iteration cap, the persona, and — most importantly — which tools the session is allowed to run at all.
- **tool call** — A request from the model to run one named function with structured arguments — read a log, restart a service, call an appliance endpoint. COSA answers each one with a result the model sees on its next turn.
- **probe** — A read-only check that reads live state without changing it — an SSH command, a service status query, a scalar SQL read. Probes are what COSA trusts; a probe result is evidence, where a tool return code is only a claim.
- **runbook** — A stored, ordered procedure for a known fix: a list of steps, each a tool call, with a convergence contract between them. Replaying a runbook is how COSA repeats a fix it already knows without asking the model to re-derive it.
- **watcher** — A small operator-described predicate — "alert me if disk is over 85%" — evaluated against each appliance status snapshot. Watchers are stored rather than compiled, and run inside a sandbox because the operator wrote them.
- **skill** — A short written procedure COSA keeps in skills.db and lists compactly in every system prompt, so a later session can recall how a past problem was solved. Some are seeded; the rest COSA writes itself after a session the judge graded as resolved.
- **judge** — A cheap second model pass that reads a closed session and grades whether the stated objective was actually met. It treats any re-probe verdict as ground truth over the transcript, and its verdict gates whether the session may become a skill.
- **FTS5** — SQLite full-text search. COSA indexes every session turn with it, so past incidents can be searched by wording rather than only by id or date.
- **redaction** — Stripping secrets — tokens, keys, passwords — out of text. COSA redacts tool output before writing it to the database, not merely before showing it to the model, so a leaked secret never lands in the audit trail.

### What crosses the network boundary

**COSA has no inbound ports. So what actually leaves the host, and where does it go?**

COSA runs on its own small machine on a cafe network and talks to a payment appliance. That makes its network surface a security question before it is an architecture question. The posture is simple to state and worth verifying rather than believing: COSA listens on nothing. Every connection in the system is one COSA opens. This diagram is about the four it opens and what governs each.

Four outbound paths and nothing else: SSH to the appliance with a pinned host key, LAN HTTP to allowlisted endpoints resolved from config, IMAP/SMTP to the mail provider, and HTTPS to the Claude API. No appliance-specific knowledge is compiled in — endpoints, risk ratings and paths all live in appliance.yaml.

[Open the diagram](q_reach.architecture.html) — 6 components.

| Component | Responsibility |
|---|---|
| **Tool handlers** | Implement every concrete capability COSA has — health checks, database reads, backups, patching, network and PCI audits, watcher management, runbook control. |
| **SSH backend** | Owns the single pooled SSH connection to the appliance and refuses it outright when the host key fingerprint does not match. |
| **Appliance auth** | Wraps appliance HTTP calls with credential-store-resolved tokens and retries once after refreshing on a 401. |
| **appliance.yaml** | Declares everything appliance-specific — SSH target, host key, endpoint allowlist with risk ratings, verification policies — so no appliance knowledge is compiled into COSA. |
| **Appliance host** | Runs the POS process and its SQLite database on the Raspberry Pi COSA administers over SSH. |
| **Appliance REST API** | Serves the appliance's health, status, and allowlisted write endpoints over LAN HTTP. |

**Deliberately not shown.** Mail and the Claude API — the other two outbound paths — and the credential store that auth reads from.

#### The long read

Because there is no listening port, there is no inbound attack surface to reason about — no auth endpoint, no exposed API, nothing to scan for. What replaces it is four outbound paths, and each is constrained by something specific.

SSH to the appliance is how COSA reads logs and runs commands. The appliance host key fingerprint is pinned, checked on every connection, and a mismatch is refused and logged as a security event rather than prompting or trusting-on-first-use. The failure this prevents is the quiet one: something answers on the appliance address and COSA hands it a session.

LAN HTTP to the appliance API is the second. Endpoints are allowlisted by name and resolved from appliance.yaml; the auth layer attaches a bearer token pulled from the credential store. Path parameters are static, resolved from the credential store, or explicitly designated caller-supplied — there is no shape where a model-authored string becomes an arbitrary URL. An endpoint that is not on the allowlist is not rejected outright, which would be brittle; it is rated high risk, which routes it to the operator for approval.

The third and fourth paths — IMAP and SMTP to the mail provider, HTTPS to the Claude API — are on the internet side of the boundary and are not drawn here, precisely so the LAN story stays legible.

Read the boundaries as much as the arrows. The appliance sits on the LAN and is never exposed on COSA's internet path; COSA reaches it, not the other way around, and nothing bridges the two sides. And notice what is not in the code at all: no endpoint URL, no service name, no file path, no risk rating. All of it lives in appliance.yaml. That is what makes this a general appliance agent rather than a program about one restaurant's point-of-sale system — and it is also why the config file, not the source, is the thing to read first when the appliance changes.

#### Terms used here

- **appliance** — The restaurant point-of-sale machine COSA watches: a separate computer on the cafe LAN running the merchant application, its database, and a receipt printer. COSA never runs on it; it reaches it over SSH and LAN HTTP.
- **session** — One run of the agent from a trigger (an email, a cron tick, a typed CLI line) to a terminal status. It has a role, a model, a token budget, an iteration cap, and a row in session.db holding every turn and tool call it made.
- **runbook** — A stored, ordered procedure for a known fix: a list of steps, each a tool call, with a convergence contract between them. Replaying a runbook is how COSA repeats a fix it already knows without asking the model to re-derive it.
- **watcher** — A small operator-described predicate — "alert me if disk is over 85%" — evaluated against each appliance status snapshot. Watchers are stored rather than compiled, and run inside a sandbox because the operator wrote them.
- **IMAP / SMTP** — The two standard mail protocols. IMAP is how COSA reads the operator inbox, polled once a minute; SMTP is how it sends. Together they are the whole user interface — COSA opens no port of its own.
- **host key pinning** — Recording the appliance SSH host key fingerprint in advance and refusing to connect if the machine that answers presents a different one. It turns a silent man-in-the-middle into a refused connection and a logged security event.
- **allowlist** — A closed list of what is permitted, where anything not named is refused. COSA allowlists the appliance HTTP endpoints it may call; an endpoint absent from the list is rated high risk rather than quietly allowed.

### Replaying a known fix

**COSA already knows how to fix this. How does it replay that fix without drifting?**

Some problems recur, and their fix is known. Asking a language model to re-derive that fix every time is expensive, slow, and — worst — non-deterministic in a system that is restarting services on a live payment machine. A runbook is the alternative: the procedure written down once and replayed exactly. The risk a replay introduces is drift, where step three runs against a state that step two failed to produce, and this diagram is about how that is prevented.

The procedure is stored as a runbook and executed step by step, each step dispatched through the same registry every agent tool call goes through. Between steps a convergence contract of tool, field, and expected value — the same contract the action verifier uses — must be satisfied before the next step runs, so a step that silently did nothing stops the runbook instead of being built on. Every run and its per-step status is logged to session.db.

[Open the diagram](q_remediate.architecture.html) — 4 components.

| Component | Responsibility |
|---|---|
| **Runbook engine** | Stores multi-step remediation procedures and executes them step by step against a convergence contract of tool, field, and expected value. |
| **Tool registry** | Holds every tool's schema, risk level, and handler, and refuses at dispatch time any tool whose risk exceeds what the session's role may run. |
| **Tool handlers** | Implement every concrete capability COSA has — health checks, database reads, backups, patching, network and PCI audits, watcher management, runbook control. |
| **Session store** | Persists every session, turn, tool call, approval, alert, watcher, and dead letter, with full-text search across the whole conversation history. |

**Deliberately not shown.** What decides to run a runbook in the first place — severity roll-up and incident escalation live on the detection side, and no scheduled task invokes a runbook directly.

#### The long read

A runbook is stored as an ordered list of steps, each one a tool call. The runbook engine executes them one at a time, and the first thing to notice is what it does not do: it does not have its own execution path. Every step is dispatched through the same tool registry every agent tool call goes through, which means every step passes the same five-stage guard pipeline — the same role gate, the same security gate, the same approval requirement, the same output sanitizer. A runbook cannot be used to launder a privileged action past the checks. If a step needs operator approval when the model asks for it, it needs approval when a runbook asks for it.

Between steps sits the convergence check, and this is what makes replay safe. Each step carries a contract — a tool, a field, and the value that field must show — and that contract must be satisfied before the next step runs. It is the same contract structure the action verifier uses after an agent action, evaluated from a different entry point. So a step that returned success and changed nothing does not become the foundation of step three; it stops the runbook where the divergence actually happened, with a per-step status saying which step and what the field showed instead.

Every run and every step outcome is logged to session.db alongside the agent sessions, which means a replayed fix and a reasoned-out fix leave the same kind of evidence.

What this diagram deliberately does not answer is who decides to run a runbook. Severity roll-up and incident escalation live on the detection side, and as the code stands no scheduled task invokes a runbook directly — the trigger is an agent session or the operator. That is a real gap between the mechanism and its use, and it belongs in the reader's head rather than hidden behind an arrow that does not exist.

#### Terms used here

- **SAM** — State-Action-Model: a loop that alternates proposing an action, accepting or rejecting it against the current model, and computing the next state. In COSA one agent session is one SAM instance, so a turn can only move the session to a status the machine allows.
- **session** — One run of the agent from a trigger (an email, a cron tick, a typed CLI line) to a terminal status. It has a role, a model, a token budget, an iteration cap, and a row in session.db holding every turn and tool call it made.
- **role** — The permission and cost profile a session is started with. The role picks the model, the token budget, the iteration cap, the persona, and — most importantly — which tools the session is allowed to run at all.
- **tool call** — A request from the model to run one named function with structured arguments — read a log, restart a service, call an appliance endpoint. COSA answers each one with a result the model sees on its next turn.
- **convergence contract** — A triple of tool, field and expected value that says what "it worked" means for a given action. The action verifier and the runbook engine evaluate the same contract, so a step that reported success but changed nothing is caught in either path.
- **runbook** — A stored, ordered procedure for a known fix: a list of steps, each a tool call, with a convergence contract between them. Replaying a runbook is how COSA repeats a fix it already knows without asking the model to re-derive it.
- **watcher** — A small operator-described predicate — "alert me if disk is over 85%" — evaluated against each appliance status snapshot. Watchers are stored rather than compiled, and run inside a sandbox because the operator wrote them.
- **FTS5** — SQLite full-text search. COSA indexes every session turn with it, so past incidents can be searched by wording rather than only by id or date.
- **redaction** — Stripping secrets — tokens, keys, passwords — out of text. COSA redacts tool output before writing it to the database, not merely before showing it to the model, so a leaked secret never lands in the audit trail.
- **severity roll-up** — Folding many individual findings into one ranked judgement (low, medium or high) so the operator gets one graded alert instead of a stream of raw observations.

### Adding a monitor without adding code

**The operator wants COSA to watch something new. What has to change, and who writes it?**

A monitoring system decays the moment the things worth watching stop matching the things someone wrote code for a year ago. COSA has two answers to that and a third it has designed but not built, and the honest version of this diagram shows all three, marked for what they are. Read it as a roadmap with the built parts labelled, not as a description of a finished system.

A data row, not a deploy. A monitor names a read-only probe, its parameters, the thresholds that make a result medium or high, and an email template; the scheduler runs the enabled rows every fifteen minutes. The route where COSA proposes a row from what it has observed and creates it once the operator approves is designed, named in the code, and not implemented.

[Open the diagram](q_extend.architecture.html) — 6 components.

| Component | Responsibility |
|---|---|
| **Cron scheduler** | Fires the unattended workload on a schedule — health checks, backups, patching, audits, watcher evaluation, digests — under a mutex so two tasks never overlap. |
| **observation-monitors.js** | Declares each observation monitor as a data row — probe, params, thresholds, template, enabled flag — so a new monitor is an edit here rather than new code. |
| **Observation monitor** | Evaluates monitors declared as data rows — probe, params, thresholds, report template — so a new monitor needs no new code. |
| **SSH backend** | Owns the single pooled SSH connection to the appliance and refuses it outright when the host key fingerprint does not match. |
| **Monitor self-authoring** *(planned)* | Would let COSA propose a new monitor row from what it has observed and create it only after the operator approves — the designed use of the data-driven substrate. |
| **Approval engine** | Emails the operator a one-time token for any non-read action and holds the tool call until they approve, deny, or the request expires. |

**Deliberately not shown.** Watchers — the other no-deploy route, for conditions visible in the status snapshot — are drawn with their sandbox on the unattended-detection view, and the alerting path once a monitor fires is there too.

#### The long read

Two mechanisms exist today, and they are not redundant — they cover different signals on purpose.

A watcher works over the appliance status snapshot: the fields COSA already collects on every poll. The operator describes the condition in an email, it is stored as a predicate, and it is evaluated on each snapshot. Because the operator wrote it, it never runs in the main process — it goes into a fresh child process per invocation, and inside that a restricted vm context with no filesystem or network reach. Two nested boundaries for a one-line expression looks like overkill until you notice the expression arrived by email.

An observation monitor covers what a watcher structurally cannot see: signals that require actually going and looking — an SSH command, a log pattern count, a ping, a scalar read out of the merchant database. The monitor is a row of data naming which read-only probe to run, its parameters, the numeric thresholds that make a result medium or high, and the template for the email. Every probe kind is read-only and its inputs are validated and escaped, which is what keeps a monitor definition from ever becoming arbitrary command execution. The scheduler reads the enabled rows every fifteen minutes and runs them.

So adding a monitor is a data edit rather than a code change — but read that claim precisely, because it is easy to over-hear. It says the substrate is data-driven. It does not say COSA extends itself. Someone still has to write the row.

That is the third route on the diagram, and it is drawn as planned because it is planned: COSA proposes a monitor from what it has actually observed, the operator approves it, and only then does it become an enabled row. The approval gate is what separates self-extension from self-modification, and it is the reason this is designed as a workflow rather than as a function that writes a file. At this revision the code names the intent in a comment and nothing implements it.

One more thing the diagram makes visible. Two of the five defined monitor rows ship disabled, because they reproduce signals that hand-written code already owns — Pi under-voltage and payment-processor timeouts. They exist to prove the primitive covers those cases. Until they are turned on and the bespoke code retired, those two signals have two possible owners, which is exactly the state that produces a monitor everyone assumes someone else is watching.

#### Terms used here

- **appliance** — The restaurant point-of-sale machine COSA watches: a separate computer on the cafe LAN running the merchant application, its database, and a receipt printer. COSA never runs on it; it reaches it over SSH and LAN HTTP.
- **tool call** — A request from the model to run one named function with structured arguments — read a log, restart a service, call an appliance endpoint. COSA answers each one with a result the model sees on its next turn.
- **approval token** — A one-time code mailed to the operator when a session wants to run a risky tool. The tool stays blocked until the operator replies APPROVE with that code, and the code expires; a DENY or an expiry ends the attempt.
- **probe** — A read-only check that reads live state without changing it — an SSH command, a service status query, a scalar SQL read. Probes are what COSA trusts; a probe result is evidence, where a tool return code is only a claim.
- **watcher** — A small operator-described predicate — "alert me if disk is over 85%" — evaluated against each appliance status snapshot. Watchers are stored rather than compiled, and run inside a sandbox because the operator wrote them.
- **observation monitor** — A monitoring rule expressed purely as data: which read-only probe to run, its parameters, the numeric thresholds that make a result medium or high severity, and the email template. Adding one is a data edit, not new code.
- **sandbox** — An isolated execution context for code COSA did not write. Watcher predicates get two nested layers: a fresh child process per invocation, and a restricted vm context inside it with no filesystem or network reach.
- **host key pinning** — Recording the appliance SSH host key fingerprint in advance and refusing to connect if the machine that answers presents a different one. It turns a silent man-in-the-middle into a refused connection and a logged security event.

## Boundaries

A boundary is a claim about everything inside it.

### COSA Pi

*deployment boundary.* Runs in the COSA Node process on its own Raspberry Pi and accepts no inbound network connections; every link to the outside is an outbound connection COSA opens.

Contains: Email gateway, Cron scheduler, CLI REPL, Intent classifier, Orchestrator, Context builder, Context compressor, Tool registry, Security gate, Approval engine, Action verifier, Session judge, Post-session hook, Tool handlers, SSH backend, Appliance auth, Watcher registry, Watcher sandbox worker, Observation monitor, Runbook engine, Appliance state machine, Session store, Skill store, Credential store, Memory manager, appliance.yaml, Home-IP updater, Skill creation FSM, observation-monitors.js, Monitor self-authoring.

Crossed by:

- **Email gateway → Gmail (IMAP/SMTP)** over https. Unseen message envelopes in, replies and alerts out. Outbound-only: COSA dials the provider every 60s.
- **Orchestrator → Claude API** over https. System prompt, full message array, and the role-filtered tool schemas; back comes text and tool_use blocks.
- **Session judge → Claude API** over https. The session transcript and a structured verdict tool; a cheap model, not the session model.

### Watcher sandbox

*process boundary.* Operator-authored watcher code runs here and only here: a fresh child process whose vm context has no require, no process, no fetch, and therefore no path to credentials, databases, or COSA's memory.

Contains: Watcher sandbox worker.

Crossed by:

- **Watcher registry → Watcher sandbox worker** over spawn. The predicate source and a cloned snapshot in; { triggered, message } out over stdio. Nothing else can cross — that is the point.

### Appliance (LAN)

*network boundary.* Lives on the managed Raspberry Pi, reachable only across the local network and never exposed to COSA's internet path.

Contains: Appliance REST API, Appliance host.

Crossed by:

- **SSH backend → Appliance host** over stdio. systemd state, process and resource metrics, SELECT results from the POS SQLite database, apt output. A fingerprint mismatch is refused as a possible MITM.
- **Appliance auth → Appliance REST API** over http. GET /health, /health/ready, /api/status, and write calls named in the endpoint allowlist. Claude chooses an endpoint by name and cannot invent one.

### Internet

*network boundary.* Third-party services COSA dials out to over TLS; none of them can initiate a connection back.

Contains: Claude API, Gmail (IMAP/SMTP), Operator.

Crossed by:

- **Operator → Gmail (IMAP/SMTP)** over manual. Questions, approval tokens, watcher descriptions, HOME-IP updates — no structured format required.

## Components

**Operator** — Asks COSA questions, approves or denies risky actions, and describes new monitoring conditions — all in plain-text email.

- Documented in: `USER_MANUAL.md`

**Gmail (IMAP/SMTP)** — Carries every message between COSA and the operator; COSA has no dashboard, app, or inbound port.

- Source: `src/email-gateway.js:31`

**Claude API** — Runs every agent turn, and separately does the cheap work — intent classification, context compression, session judging, skill drafting — on Haiku.

- Source: `src/orchestrator.js:76`

**Appliance REST API** — Serves the appliance's health, status, and allowlisted write endpoints over LAN HTTP.

- Source: `config/appliance.yaml`

**Appliance host** — Runs the POS process and its SQLite database on the Raspberry Pi COSA administers over SSH.

- Source: `src/ssh-backend.js:1`

**Email gateway** — Polls the inbox every 60 seconds and routes each unseen message by keyword to the approval engine, a suppression handler, the home-IP updater, or a new agent session.

- Source: `src/email-gateway.js:38`, `src/email-gateway.js:59`, `src/main.js:251`

**Cron scheduler** — Fires the unattended workload on a schedule — health checks, backups, patching, audits, watcher evaluation, digests — under a mutex so two tasks never overlap.

- Source: `src/cron-scheduler.js:966`, `src/cron-scheduler.js:3500`

**CLI REPL** — Dispatches typed lines as sessions for local development, with email polling and cron disabled.

- Source: `src/cli.js:1`

**Intent classifier** — Decides whether an inbound email is a read-only question or a request to change something, and fails toward the action role when ambiguous.

- Source: `src/intent-classifier.js:125`

**Home-IP updater** — Rewrites the operator's home entry in the appliance's merchant-IP allowlist directly from a keyword email, bypassing the agent loop.

- Source: `src/home-ip-allowlist.js:482`

**Orchestrator** — Runs one session as a SAM instance — call Claude, accept the response, dispatch tools, repeat until a terminal state — and picks the model, token budget, and iteration cap from the session's role.

- Source: `src/orchestrator.js:577`, `src/orchestrator.js:410`

**Context builder** — Assembles the system prompt for a session from the role persona, the appliance identity file, operator memory, and the compact skill index.

- Source: `src/context-builder.js:246`

**Context compressor** — Replaces the middle of a long conversation with a Haiku-written summary once message size crosses a threshold, keeping the first and last turns intact.

- Source: `src/context-compressor.js:221`

**Tool registry** — Holds every tool's schema, risk level, and handler, and refuses at dispatch time any tool whose risk exceeds what the session's role may run.

- Source: `src/tool-registry.js:37`, `src/tool-registry.js:219`

**Security gate** — Blocks dangerous command patterns before a tool runs and strips credentials from its output before that output reaches the model or the database.

- Source: `src/security-gate.js:295`

**Approval engine** — Emails the operator a one-time token for any non-read action and holds the tool call until they approve, deny, or the request expires.

- Source: `src/approval-engine.js:647`

**Action verifier** — Re-probes live appliance state after a mutating tool call and appends the verdict to the tool result, so the model gets deterministic ground truth on its next turn.

- Source: `src/action-verifier.js:209`, `src/orchestrator.js:297`

**Session judge** — Grades a closed action session as resolved, unresolved, or uncertain, treating any re-probe verdict in the transcript as ground truth.

- Source: `src/session-judge.js:140`

**Post-session hook** — Runs after a session closes to update operator memory, invoke the judge, alert on a silently failed action, and draft a reusable skill from sessions that genuinely worked.

- Source: `src/post-session-hook.js:414`

**Session FSM** — Rejects illegal session-lifecycle transitions and forces the session into an error state rather than letting it drift.

- Source: `src/session-fsm.js:276`

**Security FSM** — Tracks an intrusion incident through its escalation states so repeated findings advance rather than re-alert.

- Source: `src/security-fsm.js:469`

**Tool handlers** — Implement every concrete capability COSA has — health checks, database reads, backups, patching, network and PCI audits, watcher management, runbook control.

- Source: `src/main.js:216`, `src/tools/health-check.js:1`

**Watcher registry** — Stores operator-described monitoring predicates, runs each against every status snapshot, and suppresses repeat alerts for a cooldown window.

- Source: `src/watcher-registry.js:425`

**Watcher sandbox worker** — Executes one watcher predicate against a cloned status snapshot inside a stripped vm context in a throwaway child process.

- Source: `src/watcher-sandbox-worker.js:79`

**Observation monitor** — Evaluates monitors declared as data rows — probe, params, thresholds, report template — so a new monitor needs no new code.

- Source: `src/observation-monitor.js:248`, `config/observation-monitors.js:1`

**Runbook engine** — Stores multi-step remediation procedures and executes them step by step against a convergence contract of tool, field, and expected value.

- Source: `src/runbook-executor.js:338`, `src/runbook-store.js:246`

**Anomaly classifier** — Reduces a set of findings to a single severity so a scheduled task knows whether to alert.

- Source: `src/anomaly-classifier.js:241`

**SSH backend** — Owns the single pooled SSH connection to the appliance and refuses it outright when the host key fingerprint does not match.

- Source: `src/ssh-backend.js:357`

**Appliance auth** — Wraps appliance HTTP calls with credential-store-resolved tokens and retries once after refreshing on a 401.

- Source: `src/appliance-auth.js:323`

**Session store** — Persists every session, turn, tool call, approval, alert, watcher, and dead letter, with full-text search across the whole conversation history.

- Source: `src/session-store.js:179`

**Skill store** — Holds seed and self-authored skill documents and serves the compact index that goes into every system prompt.

- Source: `src/skill-store.js:107`

**Credential store** — Keeps appliance secrets encrypted outside the repository and refuses to start without its key.

- Source: `src/credential-store.js:16`

**Memory manager** — Carries operator preferences and learned facts across sessions as a sectioned document folded into each system prompt.

- Source: `src/memory-manager.js:394`

**Appliance state machine** — Folds probe results into one live picture of the appliance across health, resources, application, network, and security, and marks each dimension stale on its own clock.

- Source: `src/appliance-state-machine.js:14`, `src/appliance-state-machine.js:17`

**appliance.yaml** — Declares everything appliance-specific — SSH target, host key, endpoint allowlist with risk ratings, verification policies — so no appliance knowledge is compiled into COSA.

- Source: `config/appliance.yaml:1`

**Skill creation FSM** — Guards the lifecycle that turns a resolved session into a stored skill, refusing any step out of order — evaluate, search, generate, validate, persist.

- Source: `src/skill-creation-fsm.js:10`, `src/post-session-hook.js:10`

**observation-monitors.js** — Declares each observation monitor as a data row — probe, params, thresholds, template, enabled flag — so a new monitor is an edit here rather than new code.

- Source: `config/observation-monitors.js:21`, `src/cron-scheduler.js:3561`

**Monitor self-authoring** *(planned)* — Would let COSA propose a new monitor row from what it has observed and create it only after the operator approves — the designed use of the data-driven substrate.

- Source: `src/observation-monitor.js:9`, `config/observation-monitors.js:10`
- No propose/approve/create path exists in the code at this revision; the substrate it would write to does.

## What moves between them

| From | To | Mechanism | What crosses |
|---|---|---|---|
| Operator | Gmail (IMAP/SMTP) | manual | Questions, approval tokens, watcher descriptions, HOME-IP updates — no structured format required. *(crosses Internet)* |
| Email gateway | Gmail (IMAP/SMTP) | https | Unseen message envelopes in, replies and alerts out. Outbound-only: COSA dials the provider every 60s. *(crosses COSA Pi)* |
| Email gateway | Intent classifier | in-process call | The email body; back comes query or command, which becomes the session role. |
| Email gateway | Orchestrator | in-process call | Sender, subject, body, and the classified role; the resolved reply text comes back and is mailed to the sender. |
| Email gateway | Approval engine | in-process call | A one-time token or a denial reason, matched against the pending approval that is blocking a tool call. |
| Email gateway | Home-IP updater | in-process call | The addresses parsed from the mail; handled outside the agent loop entirely. |
| Cron scheduler | Orchestrator | in-process call | A cron trigger that becomes a probe-role session — Haiku, read-only tools, tight token budget. |
| CLI REPL | Orchestrator | in-process call | One stdin line as an action-role trigger. |
| Orchestrator | Claude API | https | System prompt, full message array, and the role-filtered tool schemas; back comes text and tool_use blocks. *(crosses COSA Pi)* |
| Orchestrator | Context builder | in-process call | Role, operator memory, and the skill index; back comes the layered system prompt. |
| Orchestrator | Context compressor | in-process call | The message array when it exceeds the threshold; back comes a shorter array with a Haiku summary in place of the middle. |
| Orchestrator | Session FSM | in-process call | The proposed next session status; an illegal transition comes back as an error the render step turns into a rejected promise. |
| Context builder | Memory manager | in-process call | The sectioned preferences document that is inlined into every system prompt. |
| Context builder | Skill store | in-process call | Skill names and one-line descriptions, so the model knows what procedures already exist. |
| Orchestrator | Tool registry | in-process call | Tool name and input. A read-only role calling a mutating tool is refused here even if the model hallucinated it. |
| Orchestrator | Security gate | in-process call | The tool call before execution, and its raw output afterwards — sanitized before it is persisted, not just before the model sees it. |
| Orchestrator | Approval engine | in-process call | Risk level and a human-readable action summary; the loop blocks until approval, denial, or expiry. |
| Approval engine | Email gateway | in-process call | The approval request email carrying a one-time token that expires in 30 minutes (5 when urgent). |
| Orchestrator | Action verifier | in-process call | The tool name and input; back comes a verdict appended to the tool result, after truncation so it cannot be cut off. |
| Action verifier | Tool registry | in-process call | A configured probe call the verifier enforces as read-only, bounded by attempt and wall-time caps. |
| Action verifier | appliance.yaml | file | Per-appliance probe policies of tool, check field, and expected value; dormant until enabled. |
| Tool registry | Tool handlers | in-process call | Input already checked against the tool's ajv schema; back comes the raw result object. |
| Tool handlers | SSH backend | in-process call | Shell commands and SQL passed on stdin rather than interpolated into the command line. |
| SSH backend | Appliance host | stdio | systemd state, process and resource metrics, SELECT results from the POS SQLite database, apt output. A fingerprint mismatch is refused as a possible MITM. *(crosses Appliance (LAN))* |
| Tool handlers | Appliance auth | in-process call | The outbound request; auth resolves ${credential:...} placeholders and refreshes once on a 401. |
| Appliance auth | Appliance REST API | http | GET /health, /health/ready, /api/status, and write calls named in the endpoint allowlist. Claude chooses an endpoint by name and cannot invent one. *(crosses Appliance (LAN))* |
| Appliance auth | Credential store | database | Static path params and login secrets, read from the encrypted store — never overridable by the model. |
| Tool handlers | appliance.yaml | file | Every appliance-specific value; nothing about the appliance is compiled into COSA. |
| Cron scheduler | Watcher registry | in-process call | The live /api/status snapshot; back comes the set of watchers that triggered. |
| Watcher registry | Watcher sandbox worker | spawn | The predicate source and a cloned snapshot in; { triggered, message } out over stdio. Nothing else can cross — that is the point. *(crosses Watcher sandbox)* |
| Cron scheduler | Observation monitor | in-process call | Monitor rows — probe, params, thresholds, template; back comes a classification and rendered report. |
| Cron scheduler | Anomaly classifier | in-process call | A findings array; back comes the highest severity, which decides whether an alert is sent. |
| Cron scheduler | Email gateway | in-process call | Alert text plus a dedup key; a repeat of the same condition inside the cooldown is dropped rather than mailed. |
| Cron scheduler | Appliance state machine | in-process call | A probe result tagged with its dimension; the machine folds it into the snapshot and stamps freshness. |
| Tool handlers | Appliance state machine | in-process call | The current five-dimension picture and its staleness, so the model can answer without re-probing. |
| Appliance state machine | Session store | database | appliance_state and appliance_state_history rows, sharing session.db so the snapshot survives a restart. |
| Runbook engine | Tool registry | in-process call | Each step's tool call, then a convergence check of { tool_name, check_field, expect_value } before the next step runs. |
| Runbook engine | Session store | database | Runbook definitions and per-run status rows in tables that share session.db. |
| Orchestrator | Session store | database | One row per session, every turn (FTS5 indexed), and every tool call with input, sanitized output, risk level, and approval id. |
| Orchestrator | Post-session hook | in-process call | Session id, trigger, tool calls, and final text — dispatched without awaiting so the operator's reply is not delayed. |
| Post-session hook | Session judge | in-process call | The transcript; back comes resolved, unresolved, or uncertain. |
| Session judge | Claude API | https | The session transcript and a structured verdict tool; a cheap model, not the session model. *(crosses COSA Pi)* |
| Session judge | Session store | database | The verdict written onto the sessions row, where it gates skill authoring and remains auditable. |
| Post-session hook | Skill store | database | A Claude-drafted skill document, written only when the judge says the session genuinely worked. |
| Post-session hook | Memory manager | file | Sanitized facts extracted from tool results, patched into the operator memory document. |
| Post-session hook | Email gateway | in-process call | An alert raised when an action ran cleanly but the judge says nothing was actually fixed. |
| Cron scheduler | Security FSM | in-process call | Security findings that advance an incident through its escalation states instead of re-alerting. |
| Security gate | Credential store | in-process call | Nothing outbound; the gate matches hardcoded secret patterns so credentials never reach the model or session.db. |
| Home-IP updater | SSH backend | in-process call | The new allowlist written into the appliance .env files, followed by a service restart. |
| Post-session hook | Skill creation FSM | in-process call | The closed session and the judge verdict; the FSM accepts or rejects each step of evaluate → search → generate → validate → persist, so a skill cannot be written without having been graded and searched for first. |
| Cron scheduler | observation-monitors.js | file | The monitor definitions themselves — probe name, params, thresholds, template — filtered to the enabled ones on each 15-minute tick. |
| Observation monitor | SSH backend | in-process call | One escaped, read-only shell command per probe kind — vcgencmd, a log pattern count, a ping, or a sqlite3 -readonly scalar query — and the raw stdout back. |
| Monitor self-authoring | observation-monitors.js | file | A candidate monitor row COSA derived from what it observed. Nothing writes this file today. |
| Monitor self-authoring | Approval engine | in-process call | The proposed monitor, held for operator approval before it can become an enabled row — the gate that keeps self-extension from becoming self-modification. |

## Doctrines, guarantees and trade-offs

### Doctrines

- **The inbox is the entire user interface — no dashboard, no app, no port to open.** The operator is a restaurant owner, not an administrator; email is the one tool they already use every day.
- **A session's role picks its model, token budget, iteration cap, persona, and visible tool set together, in lockstep.** Mixing an action model with a read-only tool schema produces a session that is neither, so an unknown role normalises to the full action profile rather than a half-configured one.
- **An email the classifier cannot read confidently routes to the action agent, which can read state and ask for clarification.** The conservative default is the one that can still ask, not the one that silently does less.
- **An action is not done when the command returns; it is done when a read-only probe confirms the state changed.** The gap between 'returned 200' and 'is actually fixed' is where silent failures live, and the model cannot close it by reasoning about its own output.
- **A new observation monitor is a new data row — probe, params, thresholds, template — never new code.** It is the precondition for COSA eventually authoring its own monitors under an approval gate.
- **COSA writes its own skills from sessions that worked, and reads the resulting index back into every system prompt.** A procedure discovered once should not have to be rediscovered.
- **No appliance-specific knowledge is compiled into COSA; endpoint names, paths, methods, risk ratings, and body schemas all live in appliance.yaml.** The connector is meant to be generic — a second appliance should be a config file, not a fork.

### Guarantees

- **Every tool call passes role gate, security gate, approval gate, dispatch, and output sanitizer — in that order, with no bypass.**
- **Filtering which tools a role is shown is not the control; the registry re-checks at execution time, so a hallucinated or injected tool_use block still cannot run a mutating tool from a read-only role.**
- **Tool output is sanitized before it is written to session.db, not only before it reaches the model.** session.db is reachable through session_search and archive_search, so persisting raw output would leak any secret a tool emitted in an error string even though the model's copy was clean.
- **An appliance_api_call naming an endpoint absent from the allowlist is rated high risk rather than auto-approved.** The handler will reject it anyway, but the risk decision must not become a bypass if the handler ever changes.
- **Only a session the judge grades as genuinely resolved may become a reusable skill.** A skill written from a session that quietly failed would industrialise the failure.
- **Watcher predicates run inside two nested boundaries: a fresh child process per invocation, and a vm context with require, process, and fetch stripped.** Watcher code is generated from an email; escaping the inner sandbox must still leave the attacker outside COSA's credentials, databases, and in-memory state.
- **Repeat alerts for the same condition are suppressed for a cooldown window rather than mailed.** A sustained spike that floods the inbox trains the operator to ignore alerts.
- **Every session, turn, tool call, approval, alert, and expiry is persisted, with FTS5 search across the whole conversation history.**
- **COSA opens no listening port; SSH, appliance HTTP, mail, and the Claude API are all connections it initiates.** The managed appliance must never be reachable through COSA's internet connection.
- **Path parameters are either static, resolved from the credential store, or explicitly designated caller-supplied; the model cannot override a static one.** Otherwise a merchant id in a URL becomes a parameter the model can choose.
- **The appliance SSH host key fingerprint is verified on every connection and a mismatch is refused and logged as a possible MITM.**
- **A skill can only be written by walking the full lifecycle: evaluate, search, generate, validate, persist.** The FSM rejects a step out of order, so the search for an existing skill and the structural validation of the generated one cannot be skipped by a code path that is in a hurry.

### Constraints

- **Verification probes are enforced read-only and bounded by per-policy attempt and wall-time limits.** A verifier that can mutate is a second, unreviewed action path.
- **Each of the five state dimensions ages on its own clock, from 10 minutes for health to 4 hours for security.** A single freshness threshold would either declare security stale constantly or let health data go quietly out of date.
- **Credentials live encrypted under ~/.cosa, outside the repository, and COSA refuses to start without the key.**

### Trade-offs

- **Both verification layers are opt-in per appliance and default to dormant.** Probe policies are appliance-specific; a wrong one would report failure on a healthy system. The cost is that a fresh install has no verification until someone configures it.
- **Two monitor rows ship disabled because hand-written equivalents still own the same signals.** Pi under-voltage and Finix transfer timeouts were hand-coded before the primitive existed. The rows prove the primitive covers them, but until they are enabled and the bespoke code retired, each of those two signals has two possible owners.

### Risks

- **Self-authored monitors are designed and not built: the data substrate exists, the propose-approve-create path does not.** Phase 1 shipped the primitive that makes a monitor a data row. Until Phase 2 exists, every new monitor still requires a human to edit the file, so the self-extending claim describes the substrate, not the behaviour.

