import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendMessage, diffPrefix, serializeSegments } from '../prompt-cache.js';
import {
  catalogIndex,
  createToolCatalog,
  firstTurnRequest,
  handleLoadTools,
  isCallable,
  LOAD_TOOLS_TOOL,
  loadStats,
  toAnthropicTools,
} from '../tool-loading.js';

const READ = { name: 'Read', description: 'Read a file. Returns its text.' };
const BASH = { name: 'Bash', description: 'Run a shell command' };

const deferred = [
  { name: 'Grep', description: 'Search file contents with a regex. Fast.' },
  { name: 'WebFetch', description: 'Fetch a web page and return markdown.' },
  { name: 'WebSearch', description: 'Search the web for pages.' },
  { name: 'Notebook', description: 'Edit a notebook cell.' },
  { name: 'GitLog', description: 'Show git history for a path.' },
  { name: 'GitDiff', description: 'Show a git diff.' },
  { name: 'GitBlame', description: 'Show git blame for a file.' },
  { name: 'GitShow', description: 'Show a git commit.' },
  { name: 'GitBranch', description: 'List git branches.' },
  { name: 'GitTag', description: 'List git tags.' },
];

function setup() {
  const catalog = createToolCatalog({ core: [READ, BASH], deferred });
  const first = firstTurnRequest(catalog, {
    system: 'You are Super-agent.',
    messages: [{ role: 'user', content: 'fix login' }],
  });
  return { catalog, first };
}

test('first turn carries only core tools plus load_tools, in caller order', () => {
  const { catalog, first } = setup();
  assert.deepEqual(
    first.tools.map((tool) => tool.name),
    ['Read', 'Bash', 'load_tools'],
  );
  assert.deepEqual(first.appendedTools, []);
  assert.deepEqual(catalog.core.at(-1), LOAD_TOOLS_TOOL);
  assert.ok(first.system.startsWith('You are Super-agent.'));
  assert.ok(first.system.endsWith(catalogIndex(catalog)));
  assert.match(first.system, /- Grep: Search file contents with a regex\./);
  assert.doesNotMatch(first.system, /- Read:/);
});

test('catalogIndex is stable and one line per deferred tool', () => {
  const { catalog } = setup();
  const again = createToolCatalog({ core: [READ, BASH], deferred });
  assert.equal(catalogIndex(catalog), catalogIndex(again));
  const lines = catalogIndex(catalog)
    .split('\n')
    .filter((line) => line.startsWith('- '));
  assert.equal(lines.length, deferred.length);
  assert.equal(lines[1], '- WebFetch: Fetch a web page and return markdown.');
  assert.equal(catalogIndex(createToolCatalog({ core: [READ] })), '');
});

test('loading by name appends to appendedTools and keeps system and tools byte-identical', () => {
  const { catalog, first } = setup();
  const before = serializeSegments(first);
  const result = handleLoadTools(first, catalog, { names: ['Grep'] });
  assert.deepEqual(result.loaded, ['Grep']);
  assert.deepEqual(result.already, []);
  assert.deepEqual(result.unknown, []);
  assert.deepEqual(result.content, [{ type: 'tool_reference', tool_name: 'Grep' }]);
  assert.deepEqual(
    result.request.appendedTools.map((tool) => tool.name),
    ['Grep'],
  );
  const after = serializeSegments(result.request);
  assert.equal(after.system, before.system);
  assert.equal(after.tools, before.tools);
  assert.equal(after.messages, before.messages);
  assert.deepEqual(diffPrefix(first, result.request), { broke: 'appendedTools', appendOnly: true });
  // the input request is not mutated
  assert.deepEqual(first.appendedTools, []);
});

test('a later turn that adds messages after a load stays append-only', () => {
  const { catalog, first } = setup();
  const loaded = handleLoadTools(first, catalog, { names: ['Grep'] }).request;
  const next = appendMessage(loaded, { role: 'assistant', content: 'loaded' });
  assert.equal(diffPrefix(loaded, next).appendOnly, true);
  const second = handleLoadTools(next, catalog, { names: ['WebFetch'] });
  assert.equal(diffPrefix(next, second.request).appendOnly, true);
  assert.deepEqual(
    second.request.appendedTools.map((tool) => tool.name),
    ['Grep', 'WebFetch'],
  );
});

test('a keyword query loads at most five matches, best first', () => {
  const { catalog, first } = setup();
  const result = handleLoadTools(first, catalog, { query: 'git' });
  assert.equal(result.loaded.length, 5);
  assert.equal(result.request.appendedTools.length, 5);
  for (const name of result.loaded) assert.match(name, /^Git/);
  assert.equal(result.content.filter((block) => block.type === 'tool_reference').length, 5);
  const narrowed = handleLoadTools(first, catalog, { query: 'WEB pages' });
  assert.deepEqual(narrowed.loaded, ['WebSearch', 'WebFetch']);
});

test('keyword match is case-insensitive over description text', () => {
  const { catalog, first } = setup();
  const result = handleLoadTools(first, catalog, { query: 'REGEX' });
  assert.deepEqual(result.loaded, ['Grep']);
});

test('unknown names are reported and get no tool_reference', () => {
  const { catalog, first } = setup();
  const result = handleLoadTools(first, catalog, { names: ['Grep', 'Nope', 'grep'] });
  assert.deepEqual(result.loaded, ['Grep']);
  assert.deepEqual(result.unknown, ['Nope', 'grep']);
  const refs = result.content.filter((block) => block.type === 'tool_reference');
  assert.deepEqual(refs, [{ type: 'tool_reference', tool_name: 'Grep' }]);
  const text = result.content.find((block) => block.type === 'text');
  assert.ok(text && text.type === 'text');
  assert.match(text.text, /Nope, grep/);
});

test('nothing matched gives a text block, never an empty content array', () => {
  const { catalog, first } = setup();
  for (const input of [{}, { names: [] }, { names: ['Nope'] }, { query: 'zzzzqq' }]) {
    const result = handleLoadTools(first, catalog, input);
    assert.equal(result.loaded.length, 0);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]?.type, 'text');
    assert.deepEqual(result.request, first);
  }
});

test('loading twice is idempotent', () => {
  const { catalog, first } = setup();
  const once = handleLoadTools(first, catalog, { names: ['Grep'] });
  const twice = handleLoadTools(once.request, catalog, { names: ['Grep'] });
  assert.deepEqual(twice.loaded, []);
  assert.deepEqual(twice.already, ['Grep']);
  assert.deepEqual(
    twice.request.appendedTools.map((tool) => tool.name),
    ['Grep'],
  );
  assert.deepEqual(twice.content, [{ type: 'tool_reference', tool_name: 'Grep' }]);
  assert.deepEqual(serializeSegments(twice.request), serializeSegments(once.request));
});

test('naming a core tool reports it as already available, without a reference', () => {
  const { catalog, first } = setup();
  const result = handleLoadTools(first, catalog, { names: ['Read'] });
  assert.deepEqual(result.already, ['Read']);
  assert.deepEqual(result.loaded, []);
  assert.equal(
    result.content.some((block) => block.type === 'tool_reference'),
    false,
  );
});

test('toAnthropicTools is byte-identical, defers correctly, never caches deferred tools', () => {
  const { catalog } = setup();
  const one = JSON.stringify(toAnthropicTools(catalog));
  const two = JSON.stringify(toAnthropicTools(createToolCatalog({ core: [READ, BASH], deferred })));
  assert.equal(one, two);
  const tools = toAnthropicTools(catalog);
  assert.equal(tools.length, 3 + deferred.length);
  assert.deepEqual(
    tools.slice(0, 3).map((tool) => tool.name),
    ['Read', 'Bash', 'load_tools'],
  );
  assert.ok(tools.some((tool) => tool.defer_loading !== true));
  for (const tool of tools.slice(0, 3)) assert.equal('defer_loading' in tool, false);
  for (const tool of tools.slice(3)) {
    assert.equal(tool.defer_loading, true);
    assert.equal('cache_control' in tool, false);
  }
  for (const tool of tools) assert.ok(tool.input_schema);
  const loadWire = tools[2];
  assert.ok(loadWire);
  assert.equal(
    (loadWire.input_schema as { additionalProperties: boolean }).additionalProperties,
    false,
  );
  // loading tools never changes the wire tools
  const { first } = setup();
  handleLoadTools(first, catalog, { names: ['Grep'] });
  assert.equal(JSON.stringify(toAnthropicTools(catalog)), one);
});

test('isCallable is false before load and true after; core is always callable', () => {
  const { catalog, first } = setup();
  assert.equal(isCallable(first, 'Read'), true);
  assert.equal(isCallable(first, 'load_tools'), true);
  assert.equal(isCallable(first, 'Grep'), false);
  assert.equal(isCallable(first, 'Nope'), false);
  const loaded = handleLoadTools(first, catalog, { names: ['Grep'] }).request;
  assert.equal(isCallable(loaded, 'Grep'), true);
  assert.equal(isCallable(loaded, 'WebFetch'), false);
});

test('loadStats counts core, loaded and still-deferred tools', () => {
  const { catalog, first } = setup();
  assert.deepEqual(loadStats(first, catalog), { core: 3, loaded: 0, stillDeferred: 10 });
  const loaded = handleLoadTools(first, catalog, { names: ['Grep', 'WebFetch'] }).request;
  assert.deepEqual(loadStats(loaded, catalog), { core: 3, loaded: 2, stillDeferred: 8 });
});

test('createToolCatalog validates names and core', () => {
  assert.throws(() => createToolCatalog({ core: [READ, READ] }), /duplicate tool name: Read/);
  assert.throws(
    () => createToolCatalog({ core: [READ], deferred: [{ name: 'Read' }] }),
    /duplicate tool name: Read/,
  );
  assert.throws(
    () => createToolCatalog({ core: [READ], deferred: [{ name: 'load_tools' }] }),
    /reserved/,
  );
  assert.throws(() => createToolCatalog({ core: [{ name: 'load_tools' }] }), /reserved/);
  assert.throws(() => createToolCatalog({ core: [] }), /at least one core tool/);
  assert.throws(() => createToolCatalog({ core: [{ name: 'bad name' }] }), /invalid tool name/);
});
