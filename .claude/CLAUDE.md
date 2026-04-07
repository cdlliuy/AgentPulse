# AgentPulse — Development Guide

## Project Overview

AgentPulse is a local-first, zero-config dashboard for monitoring AI coding agent sessions (Claude Code, GitHub Copilot). Single-file architecture: `server.js` (backend) + `public/index.html` (frontend).

## Architecture

- **Backend**: `server.js` — Express + WebSocket, all REST APIs and business logic in one file
- **Frontend**: `public/index.html` — vanilla JS single-page app, no framework, no build step
- **Tests**: `server.test.js` — Jest + Supertest, 96+ tests, ~85% line coverage
- **Dependencies**: Only `express` and `ws` in production

## Development Commands

```bash
npm start          # Start server (default port 3456)
npm test           # Run all tests (must pass before committing)
npm run dev        # Dev server
npm run dev-test   # Capture all dashboard screenshots for visual validation
npm run dev-test:eventlog  # Capture Event Log view only
npm run dev-test:detail    # Capture Session Detail (Activity) view only
npm run screenshots  # Capture 4 masked screenshots (requires running server + puppeteer)
npm run demo       # Record demo GIF (requires running server + puppeteer + gif-encoder-2 + pngjs)
```

## Code Conventions

- No TypeScript, no bundler — runs directly in Node.js
- No unnecessary dependencies — keep production deps minimal (currently 2)
- Extract shared helpers only after 3+ occurrences
- All MCP env configs must pass through `maskMcpEnv()`
- No build step — frontend is served as static files

## Testing Requirements

- All tests must pass before any commit: `npm test`
- Maintain >80% line coverage: `npx jest --coverage`
- When adding new API endpoints or server logic, add corresponding tests in `server.test.js`
- Test patterns: use Supertest for HTTP endpoints, mock `fs` and `child_process` for unit tests

## UI Change Workflow

When making changes to `public/index.html` or any frontend-visible behavior:

1. **Run all unit tests**: `npm test`
2. **Run dev-test visual validation** (default for all UI changes):
   ```bash
   npm start &                     # ensure server is running
   npm install --no-save puppeteer # if not already installed
   npm run dev-test                # captures all 5 views
   # or capture a specific view:
   npm run dev-test:eventlog       # Event Log table view
   npm run dev-test:detail         # Activity timeline view
   ```
   Available views: `sessions`, `detail`, `eventlog`, `agents`, `settings`, `all` (default)
   
   Advanced usage:
   ```bash
   # List all available sessions with IDs
   node scripts/take-screenshots.js --list
   # Capture a specific session by ID
   node scripts/take-screenshots.js --view eventlog --session <id>
   # Full options
   node scripts/take-screenshots.js --view detail --session <id> --port 3456
   ```
3. **Provide screenshots to the user** so they can visually verify the UI changes without manually opening the browser. The dev-test captures:
   - `devtest-sessions.png` — Sessions list overview
   - `devtest-detail.png` — Session detail (Activity timeline)
   - `devtest-eventlog.png` — Session detail (Event Log table)
   - `devtest-agents.png` — Agents tab
   - `devtest-settings.png` — Settings & Config page
4. Screenshots use `devtest-*.png` naming (gitignored) and are saved to project root

## API Structure

22 REST endpoints + WebSocket. Key patterns:
- `GET /api/sessions` — list all sessions
- `GET /api/sessions/:id` — session detail with full timeline
- `POST /api/sessions/:id/close` — terminate active session
- `POST /api/sessions/:id/ai-summary` — generate AI summary via `claude -p`
- `GET /api/settings` — global + project settings
- `GET /api/memory` — memory files across projects
- `WS ws://localhost:3456` — real-time updates (5s interval)

## File Discovery

AgentPulse auto-discovers data from standard locations:
- Sessions: `~/.claude/sessions/` and `~/.claude/projects/*/`
- Settings: `~/.claude/settings.json` and `~/.claude.json`
- Memory: `~/.claude/projects/*/memory/`
- Skills: `~/.claude/commands/` and `.claude/commands/`
- Copilot: `~/.copilot/`

## Gitignored Assets

These are generated and not committed:
- `demo-frames/` — individual GIF frames
- `screenshot-*.png` — documentation screenshots (masked)
- `devtest-*.png` — dev-test visual validation screenshots
- `demo.gif` — animated demo (referenced in README)
- `session-names.json` — runtime session name cache
