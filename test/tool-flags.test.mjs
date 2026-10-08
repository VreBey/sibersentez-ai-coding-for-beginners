// The tool drift check (roadmap F4, tools/check-tool-flags.mjs): the words each tool's --help must still name, and
// how they are looked for. The script itself runs the installed tools; this test runs none.
// Run: node --test test/tool-flags.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedTokens, missingIn } from '../tools/check-tool-flags.mjs';
import { TOOLS, toolById } from '../server/tools.mjs';

test('the words: prompt option, plan options and values, resume, the first word of the sign-in check', () => {
  assert.deepEqual(expectedTokens(toolById('claude')), ['--permission-mode', 'plan', '--resume', 'auth']);
  assert.deepEqual(expectedTokens(toolById('codex')), ['resume', 'login']);
  assert.deepEqual(expectedTokens(toolById('copilot')), ['-i', '--plan', '--resume'], 'Copilot’s "--resume=" as its option');
  assert.deepEqual(expectedTokens(toolById('opencode')), ['--prompt', '--session']);
  for (const t of TOOLS) assert.ok(expectedTokens(t).length > 0, t.id);
});

test('as whole words: "--plan" is not found in "--planner", "plan" is found in quotes or a list', () => {
  assert.deepEqual(missingIn('  --planner  make a plan file', ['--plan']), ['--plan']);
  assert.deepEqual(missingIn('  --plan   Start in plan mode', ['--plan']), []);
  assert.deepEqual(missingIn('(choices: "acceptEdits", "default", "plan")', ['plan']), []);
  assert.deepEqual(missingIn('Commands:\n  resume  Resume a session', ['resume', 'login']), ['login']);
  assert.deepEqual(missingIn('', ['--x']), ['--x']);
});
