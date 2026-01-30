/**
 * Python Script Runner
 *
 * Node.js から Python スクリプトを実行するためのユーティリティ
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Python スクリプトディレクトリ
const PY_DIR = path.join(__dirname, '..', 'py');

/**
 * Python スクリプトを実行
 * @param {string} scriptName - スクリプト名 (e.g., 'searchable_pdf.py')
 * @param {string[]} args - コマンドライン引数
 * @param {Object} env - 追加の環境変数
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function runPythonScript(scriptName, args = [], env = {}) {
  const scriptPath = path.join(PY_DIR, scriptName);

  return new Promise((resolve, reject) => {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    const proc = spawn(pythonCmd, [scriptPath, ...args], {
      env: { ...process.env, ...env },
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
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`Python script failed with code ${code}: ${stderr || stdout}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start Python: ${err.message}`));
    });
  });
}

/**
 * Python が利用可能かチェック
 * @returns {Promise<boolean>}
 */
export async function checkPythonAvailable() {
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

  return new Promise((resolve) => {
    const proc = spawn(pythonCmd, ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * PyMuPDF がインストールされているかチェック
 * @returns {Promise<boolean>}
 */
export async function checkPyMuPdfAvailable() {
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

  return new Promise((resolve) => {
    const proc = spawn(pythonCmd, ['-c', 'import fitz; print(fitz.version)'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}
