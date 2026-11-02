/**
 * Cloud packages outside `@maka-cloud/maka-engine` must not import
 * `@maka/core`, `@maka/runtime`, `@maka/storage`, `@maka/runtime-host`,
 * or `@maka/eval`. Those go through the engine so the rust-preview cutover
 * touches one package.
 *
 * Install-free: node builtins only.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const ENGINE_PACKAGE_DIR = 'packages/cloud-maka-engine';

export const FORBIDDEN_MAKA_PACKAGES = ['core', 'runtime', 'storage', 'runtime-host', 'eval'];

const SOURCE_EXT = /\.(?:[cm]?[jt]s|tsx)$/;
const SKIP_DIRS = new Set(['dist', 'node_modules', 'coverage']);
const FROM_RE = /\bfrom\s+['"]@maka\/(core|runtime|storage|runtime-host|eval)(?:\/[^'"]*)?['"]/g;
const DYNAMIC_RE =
  /\bimport\(\s*['"]@maka\/(core|runtime|storage|runtime-host|eval)(?:\/[^'"]*)?['"]/g;
const DEP_RE = /^@maka\/(core|runtime|storage|runtime-host|eval)$/;

/**
 * @param {string} repoRoot
 * @param {{ packagesDir?: string }} [options]
 * @returns {Array<{ file: string, specifier: string, kind: 'import' | 'dependency' }>}
 */
export function findForbiddenCloudMakaImports(repoRoot, options = {}) {
  const packagesDir = options.packagesDir ?? join(repoRoot, 'packages');
  /** @type {Array<{ file: string, specifier: string, kind: 'import' | 'dependency' }>} */
  const hits = [];
  for (const name of readdirSync(packagesDir)) {
    if (!name.startsWith('cloud-') || name === 'cloud-maka-engine') continue;
    walk(join(packagesDir, name), repoRoot, hits);
  }
  return hits;
}

/**
 * @param {string} dir
 * @param {string} repoRoot
 * @param {Array<{ file: string, specifier: string, kind: 'import' | 'dependency' }>} hits
 */
function walk(dir, repoRoot, hits) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path, repoRoot, hits);
      continue;
    }
    if (entry.name === 'package.json') {
      collectDependencies(path, repoRoot, hits);
      continue;
    }
    if (entry.isSymbolicLink() || !SOURCE_EXT.test(entry.name)) continue;
    collectImports(path, repoRoot, hits);
  }
}

/**
 * @param {string} path
 * @param {string} repoRoot
 * @param {Array<{ file: string, specifier: string, kind: 'import' | 'dependency' }>} hits
 */
function collectImports(path, repoRoot, hits) {
  const source = readFileSync(path, 'utf8');
  const file = relative(repoRoot, path);
  for (const match of source.matchAll(FROM_RE)) {
    hits.push({ file, specifier: match[0], kind: 'import' });
  }
  for (const match of source.matchAll(DYNAMIC_RE)) {
    hits.push({ file, specifier: match[0], kind: 'import' });
  }
}

/**
 * @param {string} path
 * @param {string} repoRoot
 * @param {Array<{ file: string, specifier: string, kind: 'import' | 'dependency' }>} hits
 */
function collectDependencies(path, repoRoot, hits) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const file = relative(repoRoot, path);
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const dep of Object.keys(json[section] ?? {})) {
      if (DEP_RE.test(dep)) {
        hits.push({ file, specifier: dep, kind: 'dependency' });
      }
    }
  }
}
