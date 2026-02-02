#!/usr/bin/env node
/**
 * Process and Overwrite - 1件ずつ処理して即上書き
 *
 * ルール:
 * - 1ファイルずつ処理
 * - 処理完了後すぐに元ファイルを上書き
 * - 進捗を明確に表示
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = '/tmp/fax-ocr-temp';

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });
  });
}

async function processAndOverwrite(pdfPath) {
  const basename = path.basename(pdfPath, '.pdf');
  const tempPng = path.join(TEMP_DIR, `${basename}.png`);
  const tempOcr = path.join(TEMP_DIR, `${basename}.ocr.json`);
  const tempSearchable = path.join(TEMP_DIR, `${basename}.searchable.pdf`);

  // 1. PDF → PNG
  await runCommand('pdftoppm', ['-png', '-r', '300', '-singlefile', pdfPath, tempPng.replace('.png', '')]);

  // 2. OCR (multipart/form-data)
  const pngPath = tempPng.endsWith('.png') ? tempPng : tempPng + '.png';
  const formData = new FormData();
  const pngBuffer = await fs.readFile(pngPath);
  formData.append('file', new Blob([pngBuffer], { type: 'image/png' }), 'image.png');

  const ocrResponse = await fetch('http://localhost:8765/ocr', {
    method: 'POST',
    body: formData
  });

  if (!ocrResponse.ok) {
    throw new Error(`OCR failed: ${ocrResponse.status}`);
  }

  const ocrResult = await ocrResponse.json();
  await fs.writeFile(tempOcr, JSON.stringify(ocrResult, null, 2));

  // 3. Searchable PDF生成
  const pythonScript = path.join(__dirname, '..', 'py', 'searchable_pdf.py');
  await runCommand('python3', [
    pythonScript,
    '--input-pdf', pdfPath,
    '--ocr-json', tempOcr,
    '--output-pdf', tempSearchable
  ]);

  // 4. 元ファイルを上書き
  await fs.copyFile(tempSearchable, pdfPath);

  // 5. 一時ファイル削除
  const pngToDelete = tempPng.endsWith('.png') ? tempPng : tempPng + '.png';
  await fs.unlink(pngToDelete).catch(() => {});
  await fs.unlink(tempOcr).catch(() => {});
  await fs.unlink(tempSearchable).catch(() => {});

  return true;
}

async function main() {
  const inputDir = process.argv[2];
  if (!inputDir) {
    console.error('Usage: node process_and_overwrite.js <input-dir>');
    process.exit(1);
  }

  await ensureDir(TEMP_DIR);

  const files = await fs.readdir(inputDir);
  const pdfFiles = files.filter(f => f.endsWith('.pdf'));

  console.log('═'.repeat(60));
  console.log('1件ずつ処理→即上書きモード');
  console.log('═'.repeat(60));
  console.log(`対象: ${pdfFiles.length}件`);
  console.log('');

  let success = 0, failed = 0;

  for (let i = 0; i < pdfFiles.length; i++) {
    const file = pdfFiles[i];
    const filePath = path.join(inputDir, file);
    const progress = `[${i + 1}/${pdfFiles.length}]`;

    process.stdout.write(`${progress} ${file.slice(0, 50).padEnd(50)} ... `);

    try {
      await processAndOverwrite(filePath);
      console.log('✅ 上書き完了');
      success++;
    } catch (err) {
      console.log(`❌ ${err.message.slice(0, 30)}`);
      failed++;
    }
  }

  console.log('');
  console.log('═'.repeat(60));
  console.log(`完了: ${success}件 / エラー: ${failed}件`);
  console.log('═'.repeat(60));
}

main().catch(console.error);
