const path = require('path');
const fs = require('fs');
const os = require('os');
const request = require('supertest');

// ── Test fixtures ───────────────────────────────────────
const FIXTURES_DIR = path.join(__dirname, '__fixtures__');

function ensureFixturesDir() {
  if (!fs.existsSync(FIXTURES_DIR)) fs.mkdirSync(FIXTURES_DIR, { recursive: true });
}

function writeFixture(name, content) {
  ensureFixturesDir();
  const p = path.join(FIXTURES_DIR, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return p;
}

function cleanFixtures() {
  if (fs.existsSync(FIXTURES_DIR)) {
    fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  }
}

// ── Import server (does NOT start listening) ────────────
const {
  isProcessRunning,
  parseConversation,
  summarizeInput,
  suggestSessionName,
  maskSensitive,
  maskMcpEnv,
  parseFrontmatter,
  displayNameFromSlug,
  readCopilotAgents,
  parseMemoryFile,
  findRepoClaudeDir,
  slugToPath,
  discoverProjectWorkDirs,
  readCommandFiles,
  parseCopilotSession,
  buildCopilotSessionList,
  buildCopilotSettings,
  checkClaudeCli,
  app,
  server
} = require('./server');

afterAll(() => {
  server.close();
  cleanFixtures();
});

// ═══════════════════════════════════════════════════════
// 1. Pure function unit tests
// ═══════════════════════════════════════════════════════

describe('isProcessRunning', () => {
  test('returns true for current process PID', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  test('returns false for non-existent PID', () => {
    expect(isProcessRunning(999999)).toBe(false);
  });
});

describe('summarizeInput', () => {
  test('extracts command from Bash input', () => {
    expect(summarizeInput('Bash', { command: 'npm test' })).toBe('npm test');
  });

  test('extracts file_path from Read input', () => {
    expect(summarizeInput('Read', { file_path: '/a/b/c.js' })).toBe('/a/b/c.js');
  });

  test('extracts file_path from Write input', () => {
    expect(summarizeInput('Write', { file_path: '/x/y.ts' })).toBe('/x/y.ts');
  });

  test('extracts file_path from Edit input', () => {
    expect(summarizeInput('Edit', { file_path: '/foo.js' })).toBe('/foo.js');
  });

  test('extracts pattern from Grep input', () => {
    expect(summarizeInput('Grep', { pattern: 'TODO', path: 'src/' })).toBe('TODO in src/');
  });

  test('extracts pattern from Glob input', () => {
    expect(summarizeInput('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
  });

  test('extracts Agent description', () => {
    const result = summarizeInput('Agent', { subagent_type: 'explore', description: 'find files' });
    expect(result).toContain('explore');
    expect(result).toContain('find files');
  });

  test('extracts Skill name', () => {
    expect(summarizeInput('Skill', { skill: 'commit' })).toBe('commit');
  });

  test('extracts CronCreate prompt', () => {
    const result = summarizeInput('CronCreate', { prompt: 'Check for messages every 5 min' });
    expect(result).toContain('Check for messages');
  });

  test('handles null input gracefully', () => {
    expect(summarizeInput('Bash', null)).toBe('');
  });

  test('truncates long Bash commands', () => {
    const longCmd = 'x'.repeat(200);
    expect(summarizeInput('Bash', { command: longCmd }).length).toBeLessThanOrEqual(150);
  });

  test('handles unknown tool with JSON fallback', () => {
    const result = summarizeInput('CustomTool', { foo: 'bar' });
    expect(result).toContain('foo');
  });
});

describe('maskSensitive', () => {
  test('masks token-like keys', () => {
    const result = maskSensitive({ ANTHROPIC_AUTH_TOKEN: 'sk-12345678abcdefgh' });
    expect(result.ANTHROPIC_AUTH_TOKEN).not.toBe('sk-12345678abcdefgh');
    expect(result.ANTHROPIC_AUTH_TOKEN).toContain('***');
  });

  test('masks password keys', () => {
    const result = maskSensitive({ db_password: 'mysecret123' });
    expect(result.db_password).toContain('***');
  });

  test('leaves non-sensitive keys unchanged', () => {
    const result = maskSensitive({ ANTHROPIC_MODEL: 'claude-3' });
    expect(result.ANTHROPIC_MODEL).toBe('claude-3');
  });

  test('returns null for null input', () => {
    expect(maskSensitive(null)).toBeNull();
  });

  test('handles non-string values', () => {
    const result = maskSensitive({ api_key: 12345 });
    expect(result.api_key).toBe(12345); // numbers not masked
  });
});

describe('suggestSessionName', () => {
  test('uses user messages as hints', () => {
    const session = {
      recentEvents: [
        { type: 'user', text: 'Add dark mode to dashboard' }
      ],
      todos: [],
      agents: []
    };
    expect(suggestSessionName(session)).toContain('dark mode');
  });

  test('uses todos as hints', () => {
    const session = {
      recentEvents: [],
      todos: [{ content: 'Fix login bug' }, { content: 'Add tests' }],
      agents: []
    };
    const result = suggestSessionName(session);
    expect(result).toContain('Fix login bug');
  });

  test('uses agent descriptions as hints', () => {
    const session = {
      recentEvents: [],
      todos: [],
      agents: [{ description: 'Explore codebase structure' }]
    };
    expect(suggestSessionName(session)).toContain('Explore codebase');
  });

  test('uses skills as hints', () => {
    const session = {
      recentEvents: [{ type: 'skill', skill: 'commit' }],
      todos: [],
      agents: []
    };
    expect(suggestSessionName(session)).toContain('commit');
  });

  test('falls back to title', () => {
    const session = { recentEvents: [], todos: [], agents: [], title: 'My Title' };
    expect(suggestSessionName(session)).toBe('My Title');
  });

  test('falls back to Unnamed session', () => {
    const session = { recentEvents: [], todos: [], agents: [] };
    expect(suggestSessionName(session)).toBe('Unnamed session');
  });
});

// ═══════════════════════════════════════════════════════
// 2. JSONL parsing tests
// ═══════════════════════════════════════════════════════

describe('parseConversation', () => {
  test('parses empty file gracefully', () => {
    const p = writeFixture('empty.jsonl', '');
    const result = parseConversation(p);
    expect(result.totalUserMessages).toBe(0);
    expect(result.totalAssistantMessages).toBe(0);
  });

  test('counts user and assistant messages', () => {
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-04-05T10:00:00Z', message: { content: [{ type: 'text', text: 'Hello' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-04-05T10:00:01Z', message: { content: [{ type: 'text', text: 'Hi there' }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-04-05T10:00:02Z', message: { content: [{ type: 'text', text: 'Do something' }] } })
    ].join('\n');
    const p = writeFixture('basic.jsonl', lines);
    const result = parseConversation(p);
    expect(result.totalUserMessages).toBe(2);
    expect(result.totalAssistantMessages).toBe(1);
  });

  test('extracts ai-title', () => {
    const lines = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Test Session' }),
      JSON.stringify({ type: 'user', timestamp: '2026-04-05T10:00:00Z', message: { content: [{ type: 'text', text: 'Hello' }] } })
    ].join('\n');
    const p = writeFixture('title.jsonl', lines);
    const result = parseConversation(p);
    expect(result.title).toBe('Test Session');
  });

  test('counts tool calls', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant', timestamp: '2026-04-05T10:00:00Z',
        message: { content: [
          { type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'ls' } },
          { type: 'tool_use', name: 'Read', id: 't2', input: { file_path: '/a' } }
        ]}
      })
    ].join('\n');
    const p = writeFixture('tools.jsonl', lines);
    const result = parseConversation(p);
    expect(result.totalToolCalls).toBe(2);
  });

  test('tracks Agent spawns', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant', timestamp: '2026-04-05T10:00:00Z',
        message: { content: [
          { type: 'tool_use', name: 'Agent', id: 'a1', input: { description: 'Explore code', subagent_type: 'explore' } }
        ]}
      })
    ].join('\n');
    const p = writeFixture('agents.jsonl', lines);
    const result = parseConversation(p);
    expect(result.agents.length).toBe(1);
    expect(result.agents[0].description).toBe('Explore code');
    expect(result.agents[0].subagentType).toBe('explore');
    expect(result.agents[0].status).toBe('running');
  });

  test('tracks TodoWrite updates', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant', timestamp: '2026-04-05T10:00:00Z',
        message: { content: [
          { type: 'tool_use', name: 'TodoWrite', id: 'td1', input: {
            todos: [
              { content: 'Task 1', status: 'completed', activeForm: 'Doing task 1' },
              { content: 'Task 2', status: 'in_progress', activeForm: 'Doing task 2' }
            ]
          }}
        ]}
      })
    ].join('\n');
    const p = writeFixture('todos.jsonl', lines);
    const result = parseConversation(p);
    expect(result.todos.length).toBe(2);
    expect(result.todos[0].content).toBe('Task 1');
  });

  test('tracks CronCreate jobs', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant', timestamp: '2026-04-05T10:00:00Z',
        message: { content: [
          { type: 'tool_use', name: 'CronCreate', id: 'cr1', input: { cron: '*/5 * * * *', prompt: 'poll remote messages', recurring: true } }
        ]}
      })
    ].join('\n');
    const p = writeFixture('cron.jsonl', lines);
    const result = parseConversation(p);
    expect(result.cronJobs.length).toBe(1);
    expect(result.cronJobs[0].cron).toBe('*/5 * * * *');
    expect(result.cronJobs[0].recurring).toBe(true);
  });

  test('detects remote input from Slack cron', () => {
    const lines = [
      // Cron trigger that polls for remote messages
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-04-05T10:00:00Z', content: 'Run bash ~/.claude/slack-poll.sh to check for new Slack messages' }),
      // Assistant makes the poll call
      JSON.stringify({
        type: 'assistant', timestamp: '2026-04-05T10:00:01Z',
        message: { content: [{ type: 'tool_use', name: 'Bash', id: 'poll1', input: { command: 'bash ~/.claude/slack-poll.sh' } }] }
      }),
      // Tool result comes back with user command
      JSON.stringify({
        type: 'user', timestamp: '2026-04-05T10:00:02Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'poll1', content: 'Please run git status for me' }] }
      })
    ].join('\n');
    const p = writeFixture('remote.jsonl', lines);
    const result = parseConversation(p);
    const remoteInputs = result.recentEvents.filter(e => e.type === 'remote-input');
    expect(remoteInputs.length).toBe(1);
    expect(remoteInputs[0].channel).toBe('slack');
    expect(remoteInputs[0].text).toContain('git status');
  });

  test('skips empty poll results', () => {
    const lines = [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-04-05T10:00:00Z', content: 'Run bash poll remote messages' }),
      JSON.stringify({
        type: 'assistant', timestamp: '2026-04-05T10:00:01Z',
        message: { content: [{ type: 'tool_use', name: 'Bash', id: 'poll2', input: { command: 'bash poll.sh' } }] }
      }),
      JSON.stringify({
        type: 'user', timestamp: '2026-04-05T10:00:02Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'poll2', content: '(Bash completed with no output)' }] }
      })
    ].join('\n');
    const p = writeFixture('empty-poll.jsonl', lines);
    const result = parseConversation(p);
    const remoteInputs = result.recentEvents.filter(e => e.type === 'remote-input');
    expect(remoteInputs.length).toBe(0);
  });

  test('tracks Skill invocations in timeline', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant', timestamp: '2026-04-05T10:00:00Z',
        message: { content: [
          { type: 'tool_use', name: 'Skill', id: 'sk1', input: { skill: 'commit', args: '-m "fix"' } }
        ]}
      })
    ].join('\n');
    const p = writeFixture('skill.jsonl', lines);
    const result = parseConversation(p);
    const skillEvents = result.recentEvents.filter(e => e.type === 'skill');
    expect(skillEvents.length).toBe(1);
    expect(skillEvents[0].skill).toBe('commit');
  });

  test('handles malformed JSON lines gracefully', () => {
    const lines = [
      'this is not json',
      JSON.stringify({ type: 'user', timestamp: '2026-04-05T10:00:00Z', message: { content: [{ type: 'text', text: 'Hello' }] } }),
      '{ broken json }}}',
    ].join('\n');
    const p = writeFixture('malformed.jsonl', lines);
    const result = parseConversation(p);
    expect(result.totalUserMessages).toBe(1); // only valid line counted
  });

  test('handles non-existent file', () => {
    const result = parseConversation('/nonexistent/path.jsonl');
    expect(result.totalUserMessages).toBe(0);
    expect(result.agents).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════
// 3. findRepoClaudeDir tests
// ═══════════════════════════════════════════════════════

describe('findRepoClaudeDir', () => {
  test('returns null for null cwd', () => {
    expect(findRepoClaudeDir(null)).toBeNull();
  });

  test('finds .claude in current repo', () => {
    const result = findRepoClaudeDir(process.cwd());
    if (result) {
      expect(result).toContain('.claude');
      expect(fs.existsSync(result)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════
// 4. REST API integration tests
// ═══════════════════════════════════════════════════════

describe('REST API', () => {
  test('GET /api/sessions returns array', async () => {
    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/sessions with limit', async () => {
    const res = await request(app).get('/api/sessions?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(2);
  });

  test('GET /api/stats returns expected fields', async () => {
    const res = await request(app).get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalSessions');
    expect(res.body).toHaveProperty('activeSessions');
    expect(res.body).toHaveProperty('totalMessages');
    expect(res.body).toHaveProperty('totalToolCalls');
    expect(res.body).toHaveProperty('totalAgentSpawns');
    expect(res.body).toHaveProperty('projects');
    expect(Array.isArray(res.body.projects)).toBe(true);
  });

  test('GET /api/cron-jobs returns array', async () => {
    const res = await request(app).get('/api/cron-jobs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/sessions/:id returns 404 for nonexistent', async () => {
    const res = await request(app).get('/api/sessions/nonexistent-id');
    expect(res.status).toBe(404);
  });

  test('GET /api/sessions/search returns 400 without query', async () => {
    const res = await request(app).get('/api/sessions/search');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 2/);
  });

  test('GET /api/sessions/search returns 400 for short query', async () => {
    const res = await request(app).get('/api/sessions/search?q=a');
    expect(res.status).toBe(400);
  });

  test('GET /api/sessions/search returns array for valid query', async () => {
    const res = await request(app).get('/api/sessions/search?q=test');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const item of res.body) {
      expect(item).toHaveProperty('sessionId');
      expect(item).toHaveProperty('project');
      expect(item).toHaveProperty('matches');
      expect(item).toHaveProperty('snippet');
      expect(typeof item.matches).toBe('number');
    }
  });

  test('GET /api/sessions/search returns results with correct shape', async () => {
    // Use a common word that will match some sessions
    const res = await request(app).get('/api/sessions/search?q=message');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Verify no more than 50 results
    expect(res.body.length).toBeLessThanOrEqual(50);
  });

  test('GET /api/sessions/search is case-insensitive', async () => {
    // Search with different casing should return same results
    const lower = await request(app).get('/api/sessions/search?q=message');
    const upper = await request(app).get('/api/sessions/search?q=MESSAGE');
    expect(lower.status).toBe(200);
    expect(upper.status).toBe(200);
    const lowerIds = lower.body.map(r => r.sessionId).sort();
    const upperIds = upper.body.map(r => r.sessionId).sort();
    expect(lowerIds).toEqual(upperIds);
  });

  test('GET /api/settings returns MCP servers data', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.global).toHaveProperty('mcpServers');
    expect(typeof res.body.global.mcpServers).toBe('object');
    // Should mask sensitive env values in MCP configs
    for (const [name, config] of Object.entries(res.body.global.mcpServers)) {
      if (config.env) {
        for (const [k, v] of Object.entries(config.env)) {
          if (/token|secret|key|password|auth/i.test(k) && typeof v === 'string') {
            expect(v).toContain('***');
          }
        }
      }
    }
  });

  test('GET /api/settings returns global settings', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('global');
    expect(res.body).toHaveProperty('repo');
    expect(res.body).toHaveProperty('projects');
  });

  test('GET /api/settings with project filter returns scoped results', async () => {
    // Dynamically find a project slug to test with
    const allRes = await request(app).get('/api/settings');
    if (allRes.body.projects.length === 0) return; // skip if no projects
    const testSlug = allRes.body.projects[0].slug;
    const res = await request(app).get('/api/settings?project=' + testSlug);
    expect(res.status).toBe(200);
    expect(res.body.projects.length).toBeLessThanOrEqual(1);
    if (res.body.projects.length > 0) {
      expect(res.body.projects[0].slug).toBe(testSlug);
    }
  });

  test('GET /api/settings with cwd resolves repo CLAUDE.md', async () => {
    const res = await request(app).get('/api/settings?cwd=' + encodeURIComponent(process.cwd()));
    expect(res.status).toBe(200);
    // Should find the repo's .claude/CLAUDE.md if it exists
    if (res.body.repo.claudeMd) {
      expect(typeof res.body.repo.claudeMd).toBe('string');
    }
  });

  test('GET /api/memory returns array', async () => {
    const res = await request(app).get('/api/memory');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/memory with project filter scopes results', async () => {
    // Dynamically find a project slug to test with
    const allRes = await request(app).get('/api/settings');
    if (allRes.body.projects.length === 0) return;
    const testSlug = allRes.body.projects[0].slug;
    const res = await request(app).get('/api/memory?project=' + testSlug);
    expect(res.status).toBe(200);
    // All returned memories should be from the specified project
    for (const m of res.body) {
      expect(m.project).toBe(testSlug);
    }
  });

  test('PUT /api/sessions/:id/name renames session', async () => {
    // Get a real session first
    const sessions = await request(app).get('/api/sessions?limit=1');
    if (sessions.body.length === 0) return; // skip if no sessions
    const id = sessions.body[0].sessionId;

    const res = await request(app)
      .put(`/api/sessions/${id}/name`)
      .send({ name: 'Test Name' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify it persisted
    const detail = await request(app).get(`/api/sessions/${id}`);
    expect(detail.body.customName).toBe('Test Name');

    // Clean up — reset name
    await request(app).put(`/api/sessions/${id}/name`).send({ name: '' });
  });

  test('PUT /api/sessions/:id/name rejects non-string', async () => {
    const res = await request(app)
      .put('/api/sessions/test-id/name')
      .send({ name: 123 });
    expect(res.status).toBe(400);
  });

  test('DELETE /api/memory rejects paths outside .claude', async () => {
    const res = await request(app)
      .delete('/api/memory')
      .send({ filePath: '/etc/passwd' });
    expect(res.status).toBe(400);
  });

  test('DELETE /api/memory rejects paths outside memory dir', async () => {
    const res = await request(app)
      .delete('/api/memory')
      .send({ filePath: path.join(os.homedir(), '.claude', 'settings.json') });
    expect(res.status).toBe(403);
  });

  test('POST /api/sessions/:id/close returns 404 for nonexistent session', async () => {
    const res = await request(app).post('/api/sessions/nonexistent-id/close');
    expect(res.status).toBe(404);
  });

  test('POST /api/sessions/:id/close returns 400 for inactive session', async () => {
    // Find a dead session
    const sessionsRes = await request(app).get('/api/sessions');
    const deadSession = sessionsRes.body.find(s => !s.alive);
    if (!deadSession) return; // skip if no dead sessions
    const res = await request(app).post(`/api/sessions/${deadSession.sessionId}/close`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not active');
  });
});

// ═══════════════════════════════════════════════════════
// 5. New helper function tests
// ═══════════════════════════════════════════════════════

describe('parseFrontmatter', () => {
  test('parses standard frontmatter', () => {
    const content = '---\nname: test\ntype: feedback\ndescription: A test memory\n---\nBody content here';
    const { meta, body } = parseFrontmatter(content);
    expect(meta.name).toBe('test');
    expect(meta.type).toBe('feedback');
    expect(meta.description).toBe('A test memory');
    expect(body).toBe('Body content here');
  });

  test('strips quotes from values', () => {
    const content = '---\nname: "quoted value"\n---\nBody';
    const { meta } = parseFrontmatter(content);
    expect(meta.name).toBe('quoted value');
  });

  test('returns empty meta for content without frontmatter', () => {
    const { meta, body } = parseFrontmatter('Just plain text');
    expect(meta).toEqual({});
    expect(body).toBe('Just plain text');
  });

  test('handles null/empty input', () => {
    expect(parseFrontmatter(null)).toEqual({ meta: {}, body: '' });
    expect(parseFrontmatter('')).toEqual({ meta: {}, body: '' });
  });
});

describe('displayNameFromSlug', () => {
  test('extracts last segment from double-dash slug', () => {
    expect(displayNameFromSlug('c--Users--projects--myapp')).toBe('myapp');
  });

  test('handles single segment slug', () => {
    expect(displayNameFromSlug('myproject')).toBe('myproject');
  });

  test('handles multi-level slug', () => {
    expect(displayNameFromSlug('c--Users--lying--code')).toBe('code');
  });
});

describe('maskMcpEnv', () => {
  test('masks sensitive env vars in MCP configs', () => {
    const servers = {
      'my-server': {
        command: 'node',
        args: ['server.js'],
        env: { API_KEY: 'sk-1234567890abcdef', HOST: 'localhost' }
      }
    };
    const result = maskMcpEnv(servers);
    expect(result['my-server'].env.API_KEY).toContain('***');
    expect(result['my-server'].env.HOST).toBe('localhost');
    expect(result['my-server'].command).toBe('node');
  });

  test('handles servers without env', () => {
    const servers = { 'simple': { command: 'echo' } };
    const result = maskMcpEnv(servers);
    expect(result.simple.command).toBe('echo');
  });
});

describe('slugToPath', () => {
  test('resolves known project slug', () => {
    // Dynamically get a slug from discovered projects
    const dirs = discoverProjectWorkDirs();
    if (dirs.length === 0) return;
    const testSlug = dirs[0].slug;
    const result = slugToPath(testSlug);
    if (result) {
      expect(fs.existsSync(result)).toBe(true);
    }
  });

  test('returns null for single-segment slug', () => {
    expect(slugToPath('noslug')).toBeNull();
  });

  test('returns null for nonexistent path', () => {
    expect(slugToPath('z--nonexistent--path')).toBeNull();
  });
});

describe('discoverProjectWorkDirs', () => {
  test('returns array of project dirs', () => {
    const dirs = discoverProjectWorkDirs();
    expect(Array.isArray(dirs)).toBe(true);
    for (const d of dirs) {
      expect(d).toHaveProperty('slug');
      expect(d).toHaveProperty('workDir');
      expect(fs.existsSync(d.workDir)).toBe(true);
    }
  });
});

describe('readCommandFiles', () => {
  test('reads .md files with frontmatter descriptions', () => {
    const dir = path.join(FIXTURES_DIR, 'commands');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'test-cmd.md'), '---\ndescription: A test command\n---\nBody', 'utf8');
    fs.writeFileSync(path.join(dir, 'plain.md'), 'No frontmatter, just text', 'utf8');

    const cmds = readCommandFiles(dir);
    expect(cmds.length).toBe(2);

    const testCmd = cmds.find(c => c.name === '/test-cmd');
    expect(testCmd).toBeTruthy();
    expect(testCmd.description).toBe('A test command');

    const plainCmd = cmds.find(c => c.name === '/plain');
    expect(plainCmd).toBeTruthy();
    expect(plainCmd.description).toBe('No frontmatter, just text');
  });

  test('returns empty array for nonexistent dir', () => {
    expect(readCommandFiles('/nonexistent/dir')).toEqual([]);
  });
});

describe('parseMemoryFile', () => {
  test('parses MEMORY.md as index file', () => {
    const p = writeFixture('MEMORY.md', '- [Item 1](file1.md) — desc');
    const result = parseMemoryFile(p, 'q--src-Test');
    expect(result.isIndex).toBe(true);
    expect(result.displayProject).toBe('src-Test');
    expect(result.content).toContain('Item 1');
  });

  test('parses memory file with frontmatter', () => {
    const p = writeFixture('feedback_test.md', '---\nname: test feedback\ntype: feedback\ndescription: A test\n---\nFeedback body');
    const result = parseMemoryFile(p, 'q--src-MyProj');
    expect(result.isIndex).toBe(false);
    expect(result.name).toBe('test feedback');
    expect(result.type).toBe('feedback');
    expect(result.body).toBe('Feedback body');
    expect(result.displayProject).toBe('src-MyProj');
  });

  test('returns null for nonexistent file', () => {
    expect(parseMemoryFile('/nonexistent.md', 'slug')).toBeNull();
  });
});

describe('parseCopilotSession', () => {
  test('parses session with user and assistant messages', () => {
    const lines = [
      JSON.stringify({ type: 'session.start', timestamp: '2026-04-05T10:00:00Z', data: { sessionId: 'cop-1', selectedModel: 'gpt-4o' } }),
      JSON.stringify({ type: 'user.message', timestamp: '2026-04-05T10:00:01Z', data: { content: 'Hello copilot' } }),
      JSON.stringify({ type: 'assistant.message', timestamp: '2026-04-05T10:00:02Z', data: { content: 'Hi there! How can I help?' } }),
      JSON.stringify({ type: 'tool.execution_start', timestamp: '2026-04-05T10:00:03Z', data: { toolName: 'readFile', arguments: { path: '/a.ts' } } })
    ].join('\n');
    const p = writeFixture('copilot-session.jsonl', lines);
    const result = parseCopilotSession(p);
    expect(result.sessionId).toBe('cop-1');
    expect(result.model).toBe('gpt-4o');
    expect(result.totalUserMessages).toBe(1);
    expect(result.totalAssistantMessages).toBe(1);
    expect(result.totalToolCalls).toBe(1);
  });

  test('handles model change event', () => {
    const lines = [
      JSON.stringify({ type: 'session.start', timestamp: '2026-04-05T10:00:00Z', data: { sessionId: 'cop-2', selectedModel: 'gpt-4o' } }),
      JSON.stringify({ type: 'session.model_change', timestamp: '2026-04-05T10:00:01Z', data: { newModel: 'claude-sonnet' } })
    ].join('\n');
    const p = writeFixture('copilot-model-change.jsonl', lines);
    const result = parseCopilotSession(p);
    expect(result.model).toBe('claude-sonnet');
  });

  test('returns null for nonexistent file', () => {
    expect(parseCopilotSession('/nonexistent.jsonl')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// 6. Additional REST API endpoint tests
// ═══════════════════════════════════════════════════════

describe('REST API — additional endpoints', () => {
  test('GET /api/projects returns global and project data', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('global');
    expect(res.body).toHaveProperty('projects');
    expect(res.body.global).toHaveProperty('settings');
    expect(res.body.global).toHaveProperty('mcpServers');
    expect(res.body.global).toHaveProperty('claudeMd');
    expect(Array.isArray(res.body.projects)).toBe(true);
  });

  test('GET /api/projects includes per-project CLAUDE.md info', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(200);
    for (const proj of res.body.projects) {
      expect(proj).toHaveProperty('slug');
      expect(proj).toHaveProperty('displayName');
      expect(proj).toHaveProperty('claudeMdLines');
      expect(proj).toHaveProperty('memoryCount');
    }
  });

  test('GET /api/claude-code/skills returns skills by scope', async () => {
    const res = await request(app).get('/api/claude-code/skills');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.builtin)).toBe(true);
    expect(res.body.builtin.length).toBeGreaterThan(0);
    expect(res.body.builtin[0]).toHaveProperty('name');
    expect(res.body.builtin[0]).toHaveProperty('description');
    expect(Array.isArray(res.body.projects)).toBe(true);
    expect(Array.isArray(res.body.global)).toBe(true);
    expect(res.body).toHaveProperty('globalDir');
  });

  test('GET /api/copilot/skills returns commands and participants', async () => {
    const res = await request(app).get('/api/copilot/skills');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.builtinCommands)).toBe(true);
    expect(Array.isArray(res.body.builtinParticipants)).toBe(true);
    expect(res.body.builtinCommands.length).toBeGreaterThan(0);
    expect(res.body.builtinParticipants.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.projects)).toBe(true);
  });

  test('GET /api/copilot/settings returns config structure', async () => {
    const res = await request(app).get('/api/copilot/settings');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('config');
    expect(res.body).toHaveProperty('mcpServers');
    expect(res.body).toHaveProperty('agents');
    expect(res.body).toHaveProperty('projectInstructions');
    expect(res.body).toHaveProperty('prompts');
  });

  test('GET /api/copilot/sessions returns array', async () => {
    const res = await request(app).get('/api/copilot/sessions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/agents returns both agent types', async () => {
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    const claude = res.body.find(a => a.id === 'claude-code');
    const copilot = res.body.find(a => a.id === 'github-copilot');
    expect(claude).toBeTruthy();
    expect(copilot).toBeTruthy();
    expect(claude).toHaveProperty('activeSessions');
    expect(claude).toHaveProperty('totalSessions');
  });

  test('PUT /api/memory rejects invalid request', async () => {
    const res = await request(app)
      .put('/api/memory')
      .send({ filePath: '/etc/something', content: 'test' });
    expect(res.status).toBe(400);
  });

  test('PUT /api/memory rejects path outside memory dir', async () => {
    const res = await request(app)
      .put('/api/memory')
      .send({ filePath: path.join(os.homedir(), '.claude', 'settings.json'), content: 'test' });
    expect(res.status).toBe(403);
  });

  test('PUT /api/settings/global-claude-md rejects non-string', async () => {
    const res = await request(app)
      .put('/api/settings/global-claude-md')
      .send({ content: 123 });
    expect(res.status).toBe(400);
  });

  test('GET /api/sessions/:id/suggest-name returns 404 for nonexistent', async () => {
    const res = await request(app).get('/api/sessions/nonexistent-id/suggest-name');
    expect(res.status).toBe(404);
  });

  test('GET /api/sessions/:id/suggest-name returns suggestion for real session', async () => {
    const sessionsRes = await request(app).get('/api/sessions?limit=1');
    if (sessionsRes.body.length === 0) return;
    const id = sessionsRes.body[0].sessionId;
    const res = await request(app).get(`/api/sessions/${id}/suggest-name`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('suggestion');
    expect(typeof res.body.suggestion).toBe('string');
  });

  test('PUT /api/sessions/:id/title rejects non-string', async () => {
    const res = await request(app)
      .put('/api/sessions/test-id/title')
      .send({ title: 123 });
    expect(res.status).toBe(400);
  });

  test('PUT /api/sessions/:id/title returns 404 for nonexistent', async () => {
    const res = await request(app)
      .put('/api/sessions/nonexistent-id/title')
      .send({ title: 'New Title' });
    expect(res.status).toBe(404);
  });

  test('PUT /api/sessions/:id/title rejects active session', async () => {
    const sessionsRes = await request(app).get('/api/sessions');
    const activeSession = sessionsRes.body.find(s => s.alive);
    if (!activeSession) return; // skip if no active sessions
    const res = await request(app)
      .put(`/api/sessions/${activeSession.sessionId}/title`)
      .send({ title: 'New Title' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('active session');
  });

  test('PUT /api/sessions/:id/title modifies title of completed session', async () => {
    const sessionsRes = await request(app).get('/api/sessions');
    const deadSession = sessionsRes.body.find(s => !s.alive && s.title);
    if (!deadSession) return;

    const originalTitle = deadSession.title;

    // Rename
    const res = await request(app)
      .put(`/api/sessions/${deadSession.sessionId}/title`)
      .send({ title: 'Test Renamed Title' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify it took effect
    const detail = await request(app).get(`/api/sessions/${deadSession.sessionId}`);
    expect(detail.body.title).toBe('Test Renamed Title');

    // Restore original title
    await request(app)
      .put(`/api/sessions/${deadSession.sessionId}/title`)
      .send({ title: originalTitle });
  }, 15000);

  // ── Claude CLI Status ──────────────────────────────────

  test('checkClaudeCli returns status object with expected shape', () => {
    const result = checkClaudeCli();
    expect(result).toHaveProperty('available');
    expect(result).toHaveProperty('checkedAt');
    expect(typeof result.available).toBe('boolean');
    expect(typeof result.checkedAt).toBe('number');
  });

  test('GET /api/claude-cli-status returns status with install instructions', async () => {
    const res = await request(app).get('/api/claude-cli-status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('available');
    expect(res.body).toHaveProperty('checkedAt');
    if (!res.body.available) {
      expect(res.body.installInstructions).toHaveProperty('npm');
      expect(res.body.installInstructions.npm).toContain('@anthropic-ai/claude-code');
    } else {
      expect(res.body.installInstructions).toBeNull();
      expect(res.body.version).toBeTruthy();
    }
  });

  test('GET /api/claude-cli-status?refresh=true re-checks CLI', async () => {
    const res = await request(app).get('/api/claude-cli-status?refresh=true');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('available');
    // checkedAt should be recent
    expect(Date.now() - res.body.checkedAt).toBeLessThan(5000);
  });
});
