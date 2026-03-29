Hermes Agent Architecture & the COSA Pattern for BaanBaan
A Technical Report for Cognitive Fab LLC
March 28, 2026

Executive Summary
NousResearch's Hermes Agent is an open-source (MIT), self-improving autonomous agent framework that represents the most complete implementation of a persistent, learning agent available today. Its architecture offers a direct blueprint for building a COSA (Code Operate Secure Agent) — a dedicated agent that sits next to BaanBaan POS on the Raspberry Pi (or a companion device), continuously updating its code, operating its daily functions, and securing its runtime.
This report dissects Hermes's architecture subsystem by subsystem, identifies its "secret sauce," and maps each pattern onto a concrete COSA design for BaanBaan.

1. Hermes Agent Architecture Overview
1.1 The Three-Tier Model
Hermes is not a chatbot wrapper. It is a multi-interface AI system with four entry points that all converge on a single orchestration core:
┌─────────────────────────────────────────────────────┐
│                   INTERFACES                         │
│  CLI (TUI)  │  Gateway (Telegram/Discord/Slack/…)   │
│  ACP (IDE)  │  Cron (Scheduled Tasks)               │
└──────────────────────┬──────────────────────────────┘
                       │
              ┌────────▼────────┐
              │    AIAgent       │  ← Core orchestration loop
              │  (run_agent.py)  │     in run_conversation()
              └────────┬────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              EXECUTION BACKENDS                      │
│  Local │ Docker │ SSH │ Daytona │ Singularity │ Modal│
└─────────────────────────────────────────────────────┘
Every interface creates an AIAgent instance. The core loop is synchronous and deliberately simple:
pythonwhile api_call_count < max_iterations and iteration_budget.remaining > 0:
    response = client.chat.completions.create(
        model=model, messages=messages, tools=tool_schemas
    )
    if response.tool_calls:
        for tool_call in response.tool_calls:
            result = handle_function_call(tool_call.name, tool_call.args)
            messages.append(tool_result_message(result))
        api_call_count += 1
    else:
        return response.content
This simplicity is intentional — the complexity lives in the subsystems surrounding the loop, not the loop itself.
1.2 Project Structure
hermes-agent/
├── run_agent.py          # AIAgent core conversation loop
├── cli.py                # Interactive TUI (prompt_toolkit)
├── model_tools.py        # Tool discovery & orchestration
├── toolsets.py            # Tool groupings and presets
├── hermes_state.py        # SQLite session/state (FTS5)
├── batch_runner.py        # Batch trajectory generation
│
├── agent/                 # Prompt building, compression, caching
│   ├── prompt_builder.py  # System prompt assembly (layered)
│   ├── context_compressor.py  # Auto-compress when near limit
│   ├── prompt_caching.py  # Anthropic prompt caching
│   ├── auxiliary_client.py    # Side-channel LLM (vision, summaries)
│   └── trajectory.py     # Trajectory saving for RL training
│
├── tools/                 # 40+ tool implementations
│   ├── registry.py        # Self-registration at import time
│   ├── terminal_tool.py   # Terminal execution + environments
│   ├── memory_tool.py     # MEMORY.md / USER.md management
│   ├── delegate_tool.py   # Subagent spawning
│   ├── approval.py        # Dangerous command detection
│   └── tirith_security.py # Pre-exec security scanning
│
├── gateway/               # Messaging platform gateway
│   ├── run.py             # GatewayRunner daemon
│   ├── session.py         # Session routing & state
│   └── platforms/         # Telegram, Discord, Slack, WhatsApp…
│
├── cron/                  # Scheduled job storage & execution
├── honcho_integration/    # Honcho AI-native memory
├── skills/                # Bundled skills (~/.hermes/skills/)
└── environments/          # RL / benchmark framework (Atropos)

2. The Secret Sauce: Six Architectural Innovations
2.1 The Closed Learning Loop
This is Hermes's defining differentiator. It is not just an agent that executes tasks — it is an agent that gets better at executing tasks over time through a feedback cycle:
Complete complex task (5+ tool calls)
        │
        ▼
Create skill document (SKILL.md)
        │
        ▼
Skill retrieved on similar future tasks
        │
        ▼
Skill self-improves during use
        │
        ▼
Periodic memory nudges persist knowledge
        │
        ▼
FTS5 session search enables cross-session recall
        │
        ▼
Honcho builds evolving user model
The key insight: procedural memory (skills) + episodic memory (session search) + semantic memory (Honcho user model) = a complete cognitive architecture. Most agents have at best one of these three.
2.2 Layered Prompt Architecture with Cache Stability
The system prompt is assembled from ~10 layers, but the critical design choice is keeping the prompt stable for provider-side caching:
[0]  Default agent identity
[1]  Tool-aware behavior guidance
[2]  Honcho integration block (optional, first-turn only)
[3]  Optional system message
[4]  Frozen MEMORY.md snapshot (loaded once at session start)
[5]  Frozen USER.md snapshot
[6]  Skills index (compact, not full skills)
[7]  Context files (AGENTS.md, SOUL.md, .cursorrules)
[8]  Date/time + platform hints
[9]  Conversation history
[10] Current user message
The trick: MEMORY.md and USER.md are frozen snapshots injected at session start. They don't change mid-conversation. Honcho recall on subsequent turns is attached to the user message, not the system prompt, preserving the cache. This is a meaningful cost optimization — Anthropic's prompt caching gives ~90% discount on cached tokens.
2.3 Progressive Skill Disclosure
Skills are not dumped into the prompt. Hermes uses a three-level loading strategy:

Level 0: skills_list() → compact index of name + description (~3k tokens for all skills)
Level 1: skill_view(name) → full skill content + metadata (loaded on demand)
Level 2: skill_view(name, path) → specific reference file within a skill

This means the agent carries awareness of ~40+ skills at ~3k tokens cost, but only pays the full token price when it actually needs one. Skills follow the agentskills.io open standard — a SKILL.md markdown file with optional reference files.
2.4 Dual Memory Architecture
Hermes operates two independent memory systems that serve different purposes:
Local Persistent Memory (bounded, curated):

MEMORY.md — agent notes, ~2200 chars (~800 tokens)
USER.md — user profile, ~1375 chars (~500 tokens)
Managed by the agent itself via add/replace/remove actions
Character limits enforce curation — the agent must prune to make room
Scans for prompt injection, credential exfiltration, Unicode attacks before writing

Honcho AI-Native Memory (unbounded, cross-session):

Dual-peer architecture: both user and AI build representations
Dialectic reasoning derives preferences, goals, communication style
Vector embeddings for semantic recall across all sessions and platforms
Three tools: honcho_context, honcho_search, honcho_conclude
Asynchronous writes — doesn't block the conversation loop

Memory nudges are lightweight hints injected into the system prompt that remind the agent to persist important facts. In gateway mode, proactive flushing gives the agent a dedicated turn to save memories before session idle timeouts.
2.5 Defense-in-Depth Security Model
Hermes implements security as independent, composable layers:

Dangerous Command Detection — regex patterns in tools/approval.py catch destructive operations (recursive delete, service stops, disk operations, etc.)
Tirith Pre-Exec Scanning — a Rust-based binary that analyzes commands for content-level threats: homograph URLs, shell injections, obfuscated payloads. Auto-installs to $HERMES_HOME/bin/tirith.
Smart Approvals — learns which commands are safe. Four modes:

once — approve this instance only
session — approve for current session
always — permanently allowlist this pattern
deny — block execution


Container Isolation — when running in Docker/Modal/Daytona, the container is the security boundary. Dangerous command checks are bypassed because the container itself provides isolation. Docker containers run with cap-drop ALL, no-new-privileges, read-only root.
Environment Stripping — all provider API keys, gateway secrets, and tool credentials are stripped from subprocess environments. MCP servers receive only PATH, HOME, USER, LANG, TERM, SHELL, TMPDIR.
Context File Scanning — AGENTS.md, SOUL.md, .cursorrules are scanned for prompt injection before inclusion in the system prompt.
PII Redaction — optional privacy.redact_pii mode strips personally identifiable information.
User Authorization — platform allowlists + DM pairing codes for messaging gateway access.

2.6 Self-Evolution Pipeline
The hermes-agent-self-evolution repo uses DSPy + GEPA (Genetic-Pareto Prompt Evolution) to automatically optimize skills, tool descriptions, and system prompts. The process:
Read current skill/prompt ──► Generate eval dataset
        │                            ▼
        │                      GEPA Optimizer  ◄── Execution traces
        │                            │     ▲
        │                            ▼     │
        │                  Candidate variants ──► Evaluate
        │                  Constraint gates (tests, size limits)
        │                            ▼
        └──────────────── Best variant ──► PR against hermes-agent
No GPU training. Everything operates via API calls (~$2-10 per optimization run). GEPA reads execution traces to understand why things fail, then proposes targeted improvements.

3. Supporting Subsystems
3.1 Tool Registry
Tools self-register at import time via a decorator pattern in tools/registry.py. The registry provides schema storage, handler dispatch, and availability checking. Tools are organized into logical toolsets (defined in toolsets.py) — users enable/disable groups like web, terminal, skills, memory.
Parallel execution: up to 8 independent tool calls run concurrently via ThreadPoolExecutor. Interactive tools force sequential execution. File tools run concurrently only on independent paths.
3.2 Context Compression
ContextCompressor monitors token usage and compresses when approaching 50% of the model's context window. The algorithm protects the first 3 and last 4 turns, summarizes the middle via an auxiliary model call (typically Gemini Flash), and sanitizes orphaned tool-call/result pairs. Session lineage is preserved via parent_session_id when compression splits a session.
3.3 Gateway Architecture
The GatewayRunner is a persistent daemon with a critical architectural difference from the CLI: the gateway creates a fresh AIAgent for every incoming message. Persistence comes from loading/saving conversation history from SQLite (state.db). This stateless-per-message design means:

No memory leaks from long-running agent instances
Clean error boundaries per message
Session reset policies (idle timeout, daily reset) for context management

3.4 Cron System
Cron jobs are first-class agent tasks, not shell scripts. The agent receives the cron instruction as a natural language message, executes with full tool access, and delivers results to configured platforms. This means you can schedule "audit BaanBaan's git log for unauthorized changes every 6 hours" in plain English.
3.5 Subagent Delegation
The delegate_task tool spawns isolated child agents with their own conversation contexts, terminals, and tool access. Children can't talk to each other or share state (today). They return a summary to the parent. There's an active roadmap (Issue #344) for evolving this into true multi-agent orchestration with DAG workflows, specialized roles, and shared state.

4. COSA Design for BaanBaan POS
4.1 What COSA Means
Code — autonomously update BaanBaan's codebase (bug fixes, feature additions, dependency updates)
Operate — run daily operations (shift reports, inventory alerts, payment reconciliation, printer health checks)
Secure — continuously audit, harden, and monitor the POS runtime
Agent — a persistent, learning entity that gets better at all three over time
4.2 Mapping Hermes Patterns to COSA
Hermes PatternCOSA ApplicationClosed Learning LoopCOSA creates skills from BaanBaan operational patterns — e.g., "how to recover from a stuck Clover terminal," "how to restart the Star TSP100III print pipeline"MEMORY.md / USER.mdBAANBAAN.md — current system state (Clover device ID, WiFi config, Bun version, SQLite schema version). OPERATIONS.md — learned patterns (peak hours, common failure modes, menu change procedures)Skills SystemSkill library for BaanBaan-specific procedures: clover-recovery, receipt-printer-debug, shift-close-reconciliation, menu-update, git-deployCron SystemScheduled tasks: nightly reconciliation, daily backup to S3, hourly health check, weekly dependency audit, monthly PCI compliance scanTirith + ApprovalsAll code changes require independent verification before deployment. Production database writes require approval. No rm -rf or service restarts without confirmation via Telegram.Gateway (Telegram)You and Tariga receive alerts and can issue commands from your phones. "COSA, what were today's sales?" "COSA, the printer is stuck again."Context CompressionLong operational logs get summarized. COSA remembers the gist of last month's issues without carrying every line.Subagent DelegationCode changes use a delegate: one agent writes the fix, a separate isolated agent reviews the diff (the Nightwire pattern from Issue #406).
4.3 Proposed COSA Architecture
┌─────────────────────────────────────────────────────┐
│                 COSA Interfaces                      │
│  Telegram (you/Tariga)  │  CLI (on Pi)  │  Cron     │
└──────────────────────┬──────────────────────────────┘
                       │
              ┌────────▼────────┐
              │   COSA Agent     │  ← Hermes-derived loop
              │  (BaanBaan-aware)│     with BaanBaan context files
              └────────┬────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
   ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
   │  CODE    │   │ OPERATE │   │ SECURE  │
   │  Tools   │   │  Tools  │   │  Tools  │
   └─────────┘   └─────────┘   └─────────┘

CODE Tools:
  - git operations on baanbaan repo
  - bun test runner
  - diff review (independent subagent)
  - deploy (pm2/systemd restart)
  - dependency audit (npm audit / bun outdated)

OPERATE Tools:
  - SQLite query (read-only by default)
  - Clover API health check
  - Receipt printer status (Star TSP100III)
  - Shift report generator
  - Sales dashboard query
  - Gift card balance check
  - Online order status

SECURE Tools:
  - git log audit (unauthorized commits)
  - network scan (unexpected devices on HTC/miyo)
  - process monitor (unexpected listeners)
  - PCI SAQ-A compliance check
  - SQLite integrity check (PRAGMA integrity_check)
  - Clover token rotation reminder
  - Backup verification (S3 restore test)
4.4 Runtime Options
Option A: Run directly on the Pi

Hermes installs on Linux/ARM. BaanBaan's Pi is already running Bun/Node.
Memory: COSA's SQLite state.db + BaanBaan's SQLite POS database on same device
Cost: API calls only (Anthropic, OpenRouter, or Nous Portal)
Risk: Pi is resource-constrained (RAM, CPU). COSA's LLM calls are network-bound, not compute-bound, so this is viable for light-duty operation.

Option B: Companion device (e.g., $5 VPS or old laptop) with SSH backend

COSA runs on separate hardware, executes commands on Pi via SSH terminal backend
BaanBaan's Pi stays dedicated to POS operations
COSA uses backend: ssh with the Pi as target
Recommended for production — isolates agent compute from POS compute

Option C: Hybrid — COSA on VPS with Daytona/Modal for code tasks, SSH to Pi for operations

Code changes happen in a cloud sandbox (safe)
Operational commands reach the Pi via SSH
Scheduled tasks run unattended via gateway + cron
Most resilient architecture

4.5 BaanBaan-Specific Context Files
Following Hermes's pattern, COSA would load these as frozen context:
BAANBAAN.md (system identity):
markdown# BaanBaan POS System
- Runtime: Bun on Raspberry Pi (hostname: baanbaan)
- Database: SQLite (single file)
- Payment: Clover Flex via atomic orders API
- Printing: Star TSP100III via Puppeteer/Sharp HTML-to-raster
- Networks: HTC (internet/payments), miyo (local printers)
- Deployment: git pull + pm2 restart
- Online orders: Finix Tokenization Hosted Fields (SAQ A scope)
OPERATIONS.md (learned patterns):
markdown# Operational Knowledge
- Receipt stuck: check bottom-feed padding in star-raster path
- Clover unresponsive: power cycle Flex, verify HTC WiFi
- Shift close: run reconciliation against Clover dashboard
- Peak hours: 11:30-1:30 lunch, 5:30-8:00 dinner (Kirkland)
4.6 Cron Schedule (Example)
yaml# COSA cron jobs
- every 1h: "Check BaanBaan health — Pi connectivity, Clover API, printer status. Alert on Telegram if anything is down."
- every 6h: "Run git log audit on baanbaan repo. Flag any commits not from known authors."
- daily 3am: "Back up SQLite database to S3. Verify backup integrity."
- daily 6am: "Generate yesterday's sales report. Send to Telegram."
- weekly sunday 2am: "Run bun outdated. Check for security advisories. Create a skill with update plan if needed."
- monthly 1st 4am: "Run PCI SAQ-A self-assessment checklist. Report any drift."
4.7 Security Model for COSA
Given that COSA has access to a production payment system, the security model must be stricter than vanilla Hermes:

Read-only database by default — COSA opens SQLite in WAL read-only mode. Write operations require explicit tool selection with approval.
No direct Clover API writes — COSA monitors Clover health but cannot create orders or process payments autonomously.
Git changes require independent review — every code change goes through the Nightwire verification pattern: write agent → independent review agent → test runner → deploy only if all pass.
Telegram approval for destructive ops — service restarts, database writes, dependency updates require your explicit approval via Telegram.
Container isolation for code tasks — if using Option C, code changes execute in Docker/Modal sandboxes, never directly on the Pi.
Network monitoring — COSA watches for unexpected devices on both WiFi networks. A new MAC address on the miyo printer network triggers an alert.
Credential isolation — Clover API keys, Finix tokens are never passed to code execution sandboxes. COSA's operational tools access them via a restricted credential store.


5. Implementation Path
Phase 1: Install and Configure (Week 1)

Install Hermes Agent on a companion VPS or the Pi itself
Configure SSH backend to reach the Pi
Set up Telegram gateway for you and Tariga
Create BAANBAAN.md and OPERATIONS.md context files
Write initial skills: health-check, shift-report, backup

Phase 2: Operate (Weeks 2-4)

Enable cron for health checks, backups, daily reports
Let COSA build operational skills organically
Tune memory — what should COSA always remember vs. search for?
Iterate on Telegram interaction patterns

Phase 3: Secure (Weeks 3-6)

Enable Tirith scanning
Set up git audit cron
Implement network monitoring skill
Configure approval policies for destructive operations
Run first PCI self-assessment via COSA

Phase 4: Code (Weeks 4-8)

Enable code modification skills with independent verification
Start with low-risk tasks: dependency updates, formatting fixes
Graduate to bug fixes with test coverage
Build the deploy pipeline skill (git pull → test → pm2 restart)

Phase 5: Self-Improve (Ongoing)

COSA's skills library grows with each incident it handles
Enable Honcho for cross-session user modeling
Consider self-evolution pipeline for optimizing COSA's own skills
COSA becomes the living documentation of BaanBaan's operations


6. Key Takeaways
Hermes's real innovation is not any single feature — it's the closed loop. The combination of procedural memory (skills that self-improve), episodic memory (searchable session history), semantic memory (Honcho user modeling), and scheduled autonomy (cron) creates an agent that compounds its capabilities over time.
For BaanBaan, COSA represents the natural evolution of your "local, bespoke, open-source" thesis: instead of paying for SaaS monitoring, SaaS analytics, SaaS security scanning — you have a single agent that learns your specific system and gets better at running it every day. The marginal cost is API calls. The marginal value increases with every skill it creates.
The Hermes architecture is production-ready for this use case. The main adaptation work is writing BaanBaan-specific tools and context files — the orchestration, memory, security, and scheduling infrastructure is already built.