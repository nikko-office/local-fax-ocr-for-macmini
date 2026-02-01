/**
 * Local LLM Client Tests
 *
 * Uses Node.js built-in test framework with HTTP mocking
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

// Store original env
const originalEnv = { ...process.env };

// Mock HTTP server
let mockServer;
let mockServerUrl;

/**
 * Create mock LLM API server
 */
async function createMockServer(handler) {
  return new Promise((resolve) => {
    mockServer = http.createServer(handler);
    mockServer.listen(0, '127.0.0.1', () => {
      const { port } = mockServer.address();
      mockServerUrl = `http://127.0.0.1:${port}`;
      resolve(mockServerUrl);
    });
  });
}

/**
 * Close mock server
 */
async function closeMockServer() {
  if (mockServer) {
    return new Promise((resolve) => {
      mockServer.close(resolve);
      mockServer = null;
    });
  }
}

describe('Local LLM Client', () => {

  describe('isLlmEnabled', () => {
    before(() => {
      // Clear LLM_ENABLED
      delete process.env.LLM_ENABLED;
    });

    after(() => {
      // Restore original env
      process.env = { ...originalEnv };
    });

    it('returns false by default when LLM_ENABLED is not set (safety first)', async () => {
      delete process.env.LLM_ENABLED;
      // Dynamic import to get fresh module
      const { isLlmEnabled } = await import('../src/local_llm.js');
      assert.strictEqual(isLlmEnabled(), false);
    });

    it('returns true when LLM_ENABLED=true', async () => {
      process.env.LLM_ENABLED = 'true';
      const { isLlmEnabled } = await import('../src/local_llm.js');
      assert.strictEqual(isLlmEnabled(), true);
    });

    it('returns false when LLM_ENABLED=false', async () => {
      process.env.LLM_ENABLED = 'false';
      const { isLlmEnabled } = await import('../src/local_llm.js');
      assert.strictEqual(isLlmEnabled(), false);
    });
  });

  describe('checkLlmHealth', () => {
    after(async () => {
      await closeMockServer();
    });

    it('returns true when API responds with 200', async () => {
      const url = await createMockServer((req, res) => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'gemma3' }] }));
        }
      });

      const { checkLlmHealth } = await import('../src/local_llm.js');
      const result = await checkLlmHealth(`${url}/v1`);
      assert.strictEqual(result, true);

      await closeMockServer();
    });

    it('returns false when API is not available', async () => {
      const { checkLlmHealth } = await import('../src/local_llm.js');
      // Use a port that's unlikely to be in use
      const result = await checkLlmHealth('http://127.0.0.1:59999/v1');
      assert.strictEqual(result, false);
    });
  });

  describe('sanitizeLlmOutput', () => {
    it('removes code fences from output', async () => {
      const { sanitizeLlmOutput } = await import('../src/local_llm.js');
      const input = '```\n整形されたテキスト\n```';
      const result = sanitizeLlmOutput(input, 'original');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.text, '整形されたテキスト');
    });

    it('removes markdown code fences with language', async () => {
      const { sanitizeLlmOutput } = await import('../src/local_llm.js');
      const input = '```text\n整形されたテキスト\n```';
      const result = sanitizeLlmOutput(input, 'original');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.text, '整形されたテキスト');
    });

    it('removes meta commentary patterns', async () => {
      const { sanitizeLlmOutput } = await import('../src/local_llm.js');
      const input = '整形後のテキスト:\n実際の内容';
      const result = sanitizeLlmOutput(input, 'original');
      assert.strictEqual(result.valid, true);
      assert.ok(!result.text.includes('整形後のテキスト:'));
    });

    it('collapses excessive blank lines', async () => {
      const { sanitizeLlmOutput } = await import('../src/local_llm.js');
      const input = '行1\n\n\n\n\n行2';
      const result = sanitizeLlmOutput(input, 'original');
      assert.strictEqual(result.valid, true);
      assert.ok(!result.text.includes('\n\n\n\n'));
    });

    it('returns original text when output is too long (fail-open)', async () => {
      const { sanitizeLlmOutput } = await import('../src/local_llm.js');
      const original = '短いテキスト';
      const tooLong = 'x'.repeat(original.length * 3);
      const result = sanitizeLlmOutput(tooLong, original);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.text, original);
      assert.ok(result.reason.includes('too long'));
    });

    it('returns original text when output is too short (fail-open)', async () => {
      const { sanitizeLlmOutput } = await import('../src/local_llm.js');
      // Original must be > 50 chars for the short check to apply (this is 100 chars)
      const original = 'x'.repeat(100);
      const tooShort = 'y'; // 1 char, which is < 100 * 0.2 = 20
      const result = sanitizeLlmOutput(tooShort, original);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.text, original);
      assert.ok(result.reason.includes('too short'));
    });

    it('returns original text when output is empty after sanitization', async () => {
      const { sanitizeLlmOutput } = await import('../src/local_llm.js');
      const result = sanitizeLlmOutput('   \n\n   ', 'original');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.text, 'original');
    });
  });

  describe('refineOcrText', () => {
    after(async () => {
      await closeMockServer();
    });

    it('returns refined text on successful API response', async () => {
      const url = await createMockServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              choices: [{
                message: {
                  content: '整形されたテキスト'
                }
              }]
            }));
          });
        }
      });

      const { refineOcrText } = await import('../src/local_llm.js');
      const result = await refineOcrText('元のOCRテキスト', { apiUrl: `${url}/v1` });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.text, '整形されたテキスト');

      await closeMockServer();
    });

    it('returns original text with error on API failure (fail-open)', async () => {
      const url = await createMockServer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      });

      const { refineOcrText } = await import('../src/local_llm.js');
      const result = await refineOcrText('元のOCRテキスト', { apiUrl: `${url}/v1` });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.text, '元のOCRテキスト'); // Original text returned
      assert.ok(result.error.includes('500'));

      await closeMockServer();
    });

    it('returns original text when API is unreachable (fail-open)', async () => {
      const { refineOcrText } = await import('../src/local_llm.js');
      const result = await refineOcrText('元のOCRテキスト', {
        apiUrl: 'http://127.0.0.1:59999/v1',
        timeout: 1000
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.text, '元のOCRテキスト'); // Original text returned
      assert.ok(result.error); // Error message present

      await closeMockServer();
    });

    it('returns original text when API returns empty response (fail-open)', async () => {
      const url = await createMockServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              choices: [{
                message: {
                  content: ''
                }
              }]
            }));
          });
        }
      });

      const { refineOcrText } = await import('../src/local_llm.js');
      const result = await refineOcrText('元のOCRテキスト', { apiUrl: `${url}/v1` });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.text, '元のOCRテキスト'); // Original text returned
      assert.ok(result.error.includes('empty'));

      await closeMockServer();
    });

    it('uses temperature=0 for deterministic output', async () => {
      let capturedRequest = null;

      const url = await createMockServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            capturedRequest = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              choices: [{ message: { content: 'test' } }]
            }));
          });
        }
      });

      const { refineOcrText } = await import('../src/local_llm.js');
      await refineOcrText('test', { apiUrl: `${url}/v1` });

      assert.strictEqual(capturedRequest.temperature, 0);

      await closeMockServer();
    });

    it('returns original text when sanitization fails (output too long)', async () => {
      const url = await createMockServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              choices: [{
                message: {
                  content: 'x'.repeat(1000) // Way too long for short input
                }
              }]
            }));
          });
        }
      });

      const { refineOcrText } = await import('../src/local_llm.js');
      const originalText = '短いテキスト';
      const result = await refineOcrText(originalText, { apiUrl: `${url}/v1` });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.text, originalText); // Original returned
      assert.ok(result.error.includes('Sanitization failed'));

      await closeMockServer();
    });

    it('strips code fences from LLM output', async () => {
      const url = await createMockServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              choices: [{
                message: {
                  content: '```\n整形されたテキスト\n```'
                }
              }]
            }));
          });
        }
      });

      const { refineOcrText } = await import('../src/local_llm.js');
      const result = await refineOcrText('元のテキスト', { apiUrl: `${url}/v1` });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.text, '整形されたテキスト');
      assert.ok(!result.text.includes('```'));

      await closeMockServer();
    });
  });

  describe('refineOcrTextByLines', () => {
    after(async () => {
      await closeMockServer();
    });

    it('returns refined lines on successful API response', async () => {
      const url = await createMockServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              choices: [{
                message: {
                  content: '行1整形済み\n行2整形済み\n行3整形済み'
                }
              }]
            }));
          });
        }
      });

      const { refineOcrTextByLines } = await import('../src/local_llm.js');
      const result = await refineOcrTextByLines(
        ['行1', '行2', '行3'],
        { apiUrl: `${url}/v1` }
      );

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.lines, ['行1整形済み', '行2整形済み', '行3整形済み']);

      await closeMockServer();
    });

    it('returns original lines when line count mismatch (fail-open)', async () => {
      const url = await createMockServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              choices: [{
                message: {
                  content: '行1だけ' // Only 1 line instead of 3
                }
              }]
            }));
          });
        }
      });

      const { refineOcrTextByLines } = await import('../src/local_llm.js');
      const originalLines = ['行1', '行2', '行3'];
      const result = await refineOcrTextByLines(originalLines, { apiUrl: `${url}/v1` });

      assert.strictEqual(result.success, false);
      assert.deepStrictEqual(result.lines, originalLines); // Original lines returned
      assert.ok(result.error.includes('mismatch'));

      await closeMockServer();
    });

    it('returns original lines when line length is suspicious (fail-open)', async () => {
      const url = await createMockServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              choices: [{
                message: {
                  // Second line is way too long compared to original (>3x)
                  content: '行1整形済み\n' + 'x'.repeat(100) + '\n行3整形済み'
                }
              }]
            }));
          });
        }
      });

      const { refineOcrTextByLines } = await import('../src/local_llm.js');
      // Original lines need to be > 5 chars for length check to apply
      const originalLines = ['行1です', '行2テスト入力', '行3です'];
      const result = await refineOcrTextByLines(originalLines, { apiUrl: `${url}/v1` });

      assert.strictEqual(result.success, false);
      assert.deepStrictEqual(result.lines, originalLines); // Original lines returned
      assert.ok(result.error.includes('suspicious'));

      await closeMockServer();
    });

    it('strips numbered prefixes from LLM output', async () => {
      const url = await createMockServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              choices: [{
                message: {
                  // LLM added numbered prefixes
                  content: '1. 行1整形済み\n2. 行2整形済み\n3. 行3整形済み'
                }
              }]
            }));
          });
        }
      });

      const { refineOcrTextByLines } = await import('../src/local_llm.js');
      const result = await refineOcrTextByLines(
        ['行1', '行2', '行3'],
        { apiUrl: `${url}/v1` }
      );

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.lines, ['行1整形済み', '行2整形済み', '行3整形済み']);

      await closeMockServer();
    });

    it('strips code fences from output', async () => {
      const url = await createMockServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              choices: [{
                message: {
                  content: '```\n行1整形済み\n行2整形済み\n行3整形済み\n```'
                }
              }]
            }));
          });
        }
      });

      const { refineOcrTextByLines } = await import('../src/local_llm.js');
      const result = await refineOcrTextByLines(
        ['行1', '行2', '行3'],
        { apiUrl: `${url}/v1` }
      );

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.lines, ['行1整形済み', '行2整形済み', '行3整形済み']);

      await closeMockServer();
    });
  });

  describe('Environment variable configuration', () => {
    after(() => {
      process.env = { ...originalEnv };
    });

    it('uses LOCAL_LLM_API_URL from environment', async () => {
      process.env.LOCAL_LLM_API_URL = 'http://custom-host:9999/v1';
      const { getLlmApiUrl } = await import('../src/local_llm.js');
      assert.strictEqual(getLlmApiUrl(), 'http://custom-host:9999/v1');
    });

    it('uses LOCAL_LLM_MODEL from environment', async () => {
      process.env.LOCAL_LLM_MODEL = 'qwen3_vl';
      const { getLlmModel } = await import('../src/local_llm.js');
      assert.strictEqual(getLlmModel(), 'qwen3_vl');
    });

    it('uses default values when env vars not set', async () => {
      delete process.env.LOCAL_LLM_API_URL;
      delete process.env.LOCAL_LLM_MODEL;
      const { getLlmApiUrl, getLlmModel } = await import('../src/local_llm.js');
      assert.strictEqual(getLlmApiUrl(), 'http://localhost:1234/v1');
      assert.strictEqual(getLlmModel(), 'gemma3');
    });
  });
});
