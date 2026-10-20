/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  orderByDescendingWeight,
  runWorkspaceTests,
  testSourceWeight,
} from './run-workspace-tests-parallel.mjs';

function immediateSuccessSpawn(started) {
  return (_command, options) => {
    assert.ok(existsSync(options.cwd), `spawned into a missing directory: ${options.cwd}`);
    started.push(options.cwd);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('# tests 1\n'));
      child.emit('close', 0);
    });
    return child;
  };
}

async function withWorkspaceTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'maka-workspace-order-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const absolute = join(root, path);
      mkdirSync(join(absolute, '..'), { recursive: true });
      writeFileSync(absolute, contents);
    }
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the heaviest workspace is scheduled first', () => {
  const weights = { light: 1, heavy: 100, middle: 50 };
  assert.deepEqual(
    orderByDescendingWeight(['light', 'heavy', 'middle'], (dir) => weights[dir]),
    ['heavy', 'middle', 'light'],
  );
});

test('a single workspace is never weighed', () => {
  let weighed = 0;
  assert.deepEqual(
    orderByDescendingWeight(['only'], () => {
      weighed += 1;
      return 1;
    }),
    ['only'],
  );
  assert.equal(weighed, 0);
});

test('equally weighted workspaces keep their declared order', () => {
  assert.deepEqual(
    orderByDescendingWeight(['b', 'a', 'c'], () => 7),
    ['b', 'a', 'c'],
  );
});

test('build output and dependencies do not count toward a workspace weight', async () => {
  await withWorkspaceTree(
    {
      'ws-one/src/a.test.ts': 'x'.repeat(40),
      'ws-one/dist/a.test.js': 'x'.repeat(9000),
      'ws-one/node_modules/dep/dep.test.js': 'x'.repeat(9000),
      'ws-one/src/a.ts': 'x'.repeat(9000),
    },
    (root) => {
      assert.equal(testSourceWeight(root, 'ws-one'), 40);
    },
  );
});

test('an unreadable workspace weighs nothing instead of failing the run', () => {
  assert.equal(testSourceWeight(tmpdir(), 'no/such/workspace'), 0);
});

test('the run queues the heaviest workspace ahead of the lighter one', async () => {
  await withWorkspaceTree(
    {
      'ws-light/src/a.test.ts': 'x'.repeat(10),
      'ws-heavy/src/a.test.ts': 'x'.repeat(5000),
    },
    async (root) => {
      const started = [];
      await runWorkspaceTests({
        repoRoot: root,
        workspaceDirs: ['ws-light', 'ws-heavy'],
        concurrency: 1,
        spawn: immediateSuccessSpawn(started),
      });
      assert.deepEqual(
        started.map((cwd) => cwd.slice(root.length + 1)),
        ['ws-heavy', 'ws-light'],
      );
    },
  );
});

/** A child that prints each chunk in turn, then closes; `undefined` prints nothing. */
function spawnPrinting(output, code = 0) {
  const chunks = output === undefined ? [] : Array.isArray(output) ? output : [output];
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      for (const chunk of chunks) child.stdout.emit('data', Buffer.from(chunk));
      child.emit('close', code);
    });
    return child;
  };
}

async function runWith(spawn) {
  return await withWorkspaceTree({ 'ws/src/a.test.ts': 'x' }, (root) =>
    runWorkspaceTests({ repoRoot: root, workspaceDirs: ['ws'], spawn }),
  );
}

test('a workspace that exits 0 after running zero tests fails the run', async () => {
  await assert.rejects(
    runWith(spawnPrinting('TAP version 13\n1..0\n# tests 0\n# suites 0\n# pass 0\n')),
    /ws\] ran no tests/u,
  );
});

test('a workspace that exits 0 without reporting a test count fails the run', async () => {
  await assert.rejects(runWith(spawnPrinting('all good\n')), /ws\] ran no tests/u);
  await assert.rejects(runWith(spawnPrinting(undefined)), /ws\] ran no tests/u);
});

test('a workspace that ran tests passes, counts add up and a split line is read whole', async () => {
  await runWith(spawnPrinting('# tests 3\n# pass 3\n'));
  await runWith(spawnPrinting('# tests 0\n# pass 0\n# tests 2\n# pass 2\n'));
  await runWith(spawnPrinting(['# tests', ' 4\n']));
});

test('a failing workspace still reports its exit code, not the missing count', async () => {
  await assert.rejects(runWith(spawnPrinting('', 1)), /ws\] failed with code 1/u);
});

test('a real workspace whose dist holds no tests fails instead of passing empty', async () => {
  await withWorkspaceTree(
    {
      'empty/package.json': JSON.stringify({
        name: 'empty',
        scripts: { 'test:dist': 'node --test "dist/**/*.test.js"' },
      }),
      'full/package.json': JSON.stringify({
        name: 'full',
        scripts: { 'test:dist': 'node --test "dist/**/*.test.js"' },
      }),
      'full/dist/a.test.js': "require('node:test')('runs', () => {});\n",
    },
    async (root) => {
      // Inside `node --test` a nested `node --test` would run as one of our own subtests.
      const context = process.env.NODE_TEST_CONTEXT;
      delete process.env.NODE_TEST_CONTEXT;
      try {
        await runWorkspaceTests({ repoRoot: root, workspaceDirs: ['full'] });
        await assert.rejects(
          runWorkspaceTests({ repoRoot: root, workspaceDirs: ['empty'] }),
          /empty\] ran no tests/u,
        );
      } finally {
        if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
      }
    },
  );
});
