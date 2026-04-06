<p align="center">
  <h1 align="center">AgentPulse</h1>
  <p align="center">
    <strong>A unified management dashboard for AI coding agents.</strong><br>
    Monitor sessions, manage configurations, and track activity across Claude Code, GitHub Copilot, and more — all from one place.
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/agentpulse"><img src="https://img.shields.io/npm/v/agentpulse" alt="npm version"></a>
    <a href="https://github.com/cdlliuy/AgentPulse/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/agentpulse" alt="license"></a>
    <a href="https://www.npmjs.com/package/agentpulse"><img src="https://img.shields.io/npm/dt/agentpulse" alt="downloads"></a>
  </p>
</p>

---

## The Problem

AI coding agents are powerful, but managing them is chaotic:

- **Sessions scatter everywhere** — multiple agents running simultaneously with no central view
- **Context gets lost** — session history, AI-generated insights, and configuration changes disappear on restart
- **Configuration fragments** — settings, skills, memory files, and MCP servers spread across different locations and formats
- **No visibility** — hard to see what agents are doing, what they've done, and what's queued

## The Solution

AgentPulse is a **local-first, zero-config dashboard** that automatically discovers and visualizes your AI agent ecosystem. No databases, no cloud services, no setup — just install and open.

## Features

### Session Management
- **Live monitoring** — real-time view of all active and historical sessions via WebSocket
- **Multi-agent support** — Claude Code and GitHub Copilot side by side, with extensible agent architecture
- **Session control** — rename, close, and organize sessions from one place
- **Status at a glance** — active (green) vs. ended sessions, PID tracking, project grouping

### AI-Powered Summaries
- **One-click session summaries** — generate AI-powered analysis of any session via `claude -p`
- **Brief naming** — auto-suggest meaningful session names from conversation content
- **Persistent storage** — summaries survive server restarts, cached for fast access
- **Session title editing** — modify titles of completed sessions directly in the JSONL log

### Configuration Center
- **Global & project settings** — unified view of `settings.json`, `.claude.json`, and per-project overrides
- **CLAUDE.md viewer/editor** — read and edit global instructions that guide agent behavior
- **Memory management** — browse, edit, and delete memory files across all projects
- **MCP server overview** — see all configured MCP servers with masked credentials
- **Skills inventory** — slash commands and skills organized by scope (global vs. project)

### Activity & Event Log
- **Curated Event Log** — filtered, deduplicated view of session events (oldest first)
- **Full Timeline** — detailed visual workflow timeline (newest first)
- **Smart deduplication** — consecutive identical events (e.g., polling crons) collapsed with count badges
- **Flexible filtering** — filter by type: substantive, user-only, remote input, agents, or all
- **Cron job tracking** — view active and historical cron jobs across all sessions
- **Remote input detection** — automatic channel detection for Slack, Teams, WeChat, and other integrations

## Quick Start

### Install from npm

```bash
npm install -g agentpulse
agentpulse
```

Or run without installing:

```bash
npx agentpulse
```

### Install from source

```bash
git clone https://github.com/cdlliuy/AgentPulse.git
cd AgentPulse
npm install
npm start
```

Open **http://localhost:3456** in your browser. Custom port:

```bash
PORT=8080 agentpulse
```

### Run in background

```bash
PORT=3456 nohup agentpulse > agentpulse.log 2>&1 & echo $! > agentpulse.pid
```

## Zero Configuration

AgentPulse auto-discovers everything from standard locations:

| Data | Source |
|------|--------|
| Sessions | `~/.claude/sessions/` and `~/.claude/projects/*/` |
| Settings | `~/.claude/settings.json` and `~/.claude.json` |
| Memory | `~/.claude/projects/*/memory/` |
| Skills | `~/.claude/commands/` and `.claude/commands/` |
| Copilot | `~/.copilot/` |

## Architecture

AgentPulse follows a deliberately simple architecture:

- **Single `server.js`** — Express server with REST API + WebSocket, all business logic in one file
- **Single `public/index.html`** — vanilla JS frontend, no framework, no build step
- **No database** — reads directly from the agent session files on disk
- **2 dependencies** — `express` and `ws`. That's it.

## API

22 REST endpoints + WebSocket. Full reference in the source or at `/api/agents` for supported agent types.

Key endpoints:

```
GET  /api/sessions          — list all sessions
GET  /api/sessions/:id      — session detail with full event timeline
POST /api/sessions/:id/close — terminate an active session
POST /api/sessions/:id/ai-summary — generate AI summary
GET  /api/settings          — global + project settings
GET  /api/memory            — memory files across projects
GET  /api/projects          — all projects with configs
WS   ws://localhost:3456    — real-time session updates (5s interval)
```

## Who is this for?

- **AI agent power users** — developers running multiple Claude Code or Copilot sessions daily
- **Team leads** — who need visibility into AI-assisted development workflows
- **DevOps / platform engineers** — managing AI agent configurations across projects

## Contributing

```bash
npm install
npm test          # 96 tests, ~85% coverage
npm run dev       # start dev server
```

See the [contributor guide](README.md#for-contributors) section below for code style rules, testing requirements, and review checklist.

---

## For Contributors

### Project Structure

```
agentpulse/
  server.js          — Express server, REST APIs, WebSocket, all business logic
  server.test.js     — Jest + Supertest tests (96 tests, ~85% line coverage)
  public/index.html  — Single-page frontend (vanilla JS, no framework)
  package.json       — Dependencies: express, ws; devDeps: jest, supertest
  LICENSE            — MIT License
```

### Code Style

- **No build step** — runs directly in Node.js, no TypeScript, no bundler
- **Single-file architecture** — server in `server.js`, frontend in `index.html`
- **Extract shared helpers** — deduplicate after 3+ occurrences
- **Mask sensitive data** — all MCP env configs pass through `maskMcpEnv()`

### Testing

```bash
npm test                # all tests must pass
npx jest --coverage     # maintain >80% line coverage
```

### Code Review Checklist

- [ ] All 96+ tests pass
- [ ] No coverage regression (>80%)
- [ ] No duplicated logic
- [ ] Sensitive data masked
- [ ] No unnecessary new dependencies

## License

[MIT](LICENSE) — Ying Liu
