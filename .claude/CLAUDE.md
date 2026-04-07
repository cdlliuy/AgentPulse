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
2. **Generate fresh screenshots** for visual validation:
   ```bash
   npm start &                     # ensure server is running
   npm install --no-save puppeteer # if not already installed
   npm run screenshots
   ```
3. **Provide screenshots to the user** so they can visually verify the UI changes without manually opening the browser. The 4 screenshots cover:
   - Sessions list overview
   - Session detail (Activity / Event Log)
   - Agents tab
   - Settings & Config page
4. Screenshots auto-mask sensitive content (paths, usernames, project names)

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
- `scripts/` — screenshot and demo recording helpers
- `demo-frames/` — individual GIF frames
- `screenshot-*.png` — documentation screenshots
- `demo.gif` — animated demo (referenced in README)
- `session-names.json` — runtime session name cache
