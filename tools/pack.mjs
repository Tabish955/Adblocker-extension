#!/usr/bin/env node
/**
 * Aegis Ad Blocker — package the extension for distribution.
 * Requires the `zip` utility (already present in most dev environments).
 * Output: dist/aegis-ad-blocker-<version>.zip
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'dist');

const manifest = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });
const target = path.join(OUT, `aegis-ad-blocker-${manifest.version}.zip`);
if (existsSync(target)) rmSync(target);

// Validate before packing — never ship a ruleset Chrome would silently drop
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'validate-extension.mjs')], { stdio: 'inherit' });

execFileSync('zip', ['-r', '-X', target, '.'], { cwd: EXT, stdio: 'inherit' });
console.log(`\nPacked ${target}`);
