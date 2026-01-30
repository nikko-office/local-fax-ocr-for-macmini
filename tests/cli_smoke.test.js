/**
 * CLI Smoke Tests
 *
 * 基本的なCLI動作のスモークテスト
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mainPath = path.join(__dirname, '..', 'src', 'main.js');

/**
 * Run CLI with arguments
 * @param {string[]} args - CLI arguments
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runCli(args) {
  return new Promise((resolve) => {
    const proc = spawn('node', [mainPath, ...args], {
      env: { ...process.env, GOOGLE_CLOUD_API_KEY: 'test-key' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe('CLI Smoke Tests', () => {
  it('shows help with --help', async () => {
    const result = await runCli(['--help']);
    assert.strictEqual(result.code, 0, 'Should exit with 0');
    assert.ok(result.stdout.includes('FaxOCR-JS'), 'Should show tool name');
    assert.ok(result.stdout.includes('--in'), 'Should show --in option');
    assert.ok(result.stdout.includes('--out'), 'Should show --out option');
  });

  it('shows help with -h', async () => {
    const result = await runCli(['-h']);
    assert.strictEqual(result.code, 0, 'Should exit with 0');
    assert.ok(result.stdout.includes('FaxOCR-JS'), 'Should show tool name');
  });

  it('shows version with --version', async () => {
    const result = await runCli(['--version']);
    assert.strictEqual(result.code, 0, 'Should exit with 0');
    assert.ok(result.stdout.includes('faxocr-js'), 'Should show version');
    assert.ok(/v\d+\.\d+\.\d+/.test(result.stdout), 'Should have version number');
  });

  it('shows version with -v', async () => {
    const result = await runCli(['-v']);
    assert.strictEqual(result.code, 0, 'Should exit with 0');
    assert.ok(result.stdout.includes('faxocr-js'), 'Should show version');
  });

  it('shows error for missing --in in process command', async () => {
    const result = await runCli(['process']);
    assert.strictEqual(result.code, 1, 'Should exit with error');
    assert.ok(result.stderr.includes('--in'), 'Should mention --in');
  });

  it('shows error for non-existent input file', async () => {
    const result = await runCli(['process', '--in', '/nonexistent/file.pdf']);
    assert.strictEqual(result.code, 2, 'Should exit with input error');
    assert.ok(result.stderr.includes('not found'), 'Should mention file not found');
  });

  it('help shows --gemini option', async () => {
    const result = await runCli(['--help']);
    assert.ok(result.stdout.includes('--gemini'), 'Should show --gemini option');
  });

  it('help shows --searchable-pdf option', async () => {
    const result = await runCli(['--help']);
    assert.ok(result.stdout.includes('--searchable-pdf'), 'Should show --searchable-pdf option');
  });

  it('help shows --font-path option', async () => {
    const result = await runCli(['--help']);
    assert.ok(result.stdout.includes('--font-path'), 'Should show --font-path option');
  });

  it('help shows --skip-ocr option', async () => {
    const result = await runCli(['--help']);
    assert.ok(result.stdout.includes('--skip-ocr'), 'Should show --skip-ocr option');
  });

  it('help shows process command example', async () => {
    const result = await runCli(['--help']);
    assert.ok(result.stdout.includes('process'), 'Should show process command');
    assert.ok(result.stdout.includes('--in <file>'), 'Should show file argument');
  });
});
