#!/usr/bin/env node
/**
 * Batch Searchable PDF + Rename
 *
 * 1件ずつ安定処理:
 * - Searchable PDF生成 → 元ファイル上書き
 * - リネーム提案 → 適用
 * - 5件ごとに進捗確認
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_DIR = '/tmp/fax-ocr-batch';

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function runCommand(cmd, args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Timeout'));
    }, timeout);

    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });
  });
}

async function processOneFile(pdfPath, tempDir) {
  const basename = path.basename(pdfPath, '.pdf');
  const tempPng = path.join(tempDir, `${basename}.png`);
  const tempOcr = path.join(tempDir, `${basename}.ocr.json`);
  const tempSearchable = path.join(tempDir, `${basename}.searchable.pdf`);
  const tempRename = path.join(tempDir, `${basename}.rename.json`);

  const result = { searchable: false, renamed: false, newName: null, error: null };

  try {
    // 1. PDF → PNG (300dpi)
    await runCommand('pdftoppm', ['-png', '-r', '300', '-singlefile', pdfPath, tempPng.replace('.png', '')]);

    // 2. OCR (multipart/form-data)
    const pngPath = tempPng.endsWith('.png') ? tempPng : `${tempPng}.png`;
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
    result.searchable = true;

    // 5. リネーム提案生成（main.jsのrename_suggest使用）
    const mainScript = path.join(__dirname, 'main.js');
    try {
      await runCommand('node', [
        mainScript, 'process',
        '--in', pdfPath,
        '--out', tempDir,
        '--skip-ocr'
      ], 60000);

      // rename.jsonを読み込み
      const renameJsonPath = path.join(tempDir, `${basename}.rename.json`);
      const renameExists = await fs.access(renameJsonPath).then(() => true).catch(() => false);
      if (renameExists) {
        const renameData = JSON.parse(await fs.readFile(renameJsonPath, 'utf8'));
        if (renameData.stem && renameData.confidence >= 0.5) {
          const newName = `${renameData.stem}.pdf`;
          const newPath = path.join(path.dirname(pdfPath), newName);

          // 同名ファイルがなければリネーム
          const exists = await fs.access(newPath).then(() => true).catch(() => false);
          if (!exists && newName !== path.basename(pdfPath)) {
            await fs.rename(pdfPath, newPath);
            result.renamed = true;
            result.newName = newName;
          }
        }
      }
    } catch (e) {
      // リネーム失敗は無視（Searchable PDFは成功）
    }

  } catch (e) {
    result.error = e.message;
  }

  // 一時ファイル削除
  const pngToDelete = tempPng.endsWith('.png') ? tempPng : `${tempPng}.png`;
  await fs.unlink(pngToDelete).catch(() => {});
  await fs.unlink(tempOcr).catch(() => {});
  await fs.unlink(tempSearchable).catch(() => {});
  await fs.unlink(tempRename).catch(() => {});

  return result;
}

async function main() {
  const inputDir = process.argv[2];
  if (!inputDir) {
    console.error('Usage: node batch_searchable_rename.js <input-dir>');
    process.exit(1);
  }

  await ensureDir(TEMP_DIR);

  // 未処理ファイルを特定（今日の日付でないもの）
  const files = await fs.readdir(inputDir);
  const allPdfs = files.filter(f => f.endsWith('.pdf'));

  // 各ファイルの更新日時を確認して未処理を特定
  const unprocessed = [];
  const today = new Date().toDateString();

  for (const f of allPdfs) {
    const filePath = path.join(inputDir, f);
    const stat = await fs.stat(filePath);
    if (stat.mtime.toDateString() !== today) {
      unprocessed.push(f);
    }
  }

  console.log('═'.repeat(60));
  console.log('Searchable PDF + リネーム バッチ処理');
  console.log('═'.repeat(60));
  console.log(`全体: ${allPdfs.length}件 / 未処理: ${unprocessed.length}件`);
  console.log('');

  let success = 0, failed = 0, renamed = 0;

  for (let i = 0; i < unprocessed.length; i++) {
    const file = unprocessed[i];
    const filePath = path.join(inputDir, file);
    const progress = `[${i + 1}/${unprocessed.length}]`;

    process.stdout.write(`${progress} ${file.slice(0, 45).padEnd(45)} `);

    const result = await processOneFile(filePath, TEMP_DIR);

    if (result.error) {
      console.log(`❌ ${result.error.slice(0, 25)}`);
      failed++;
    } else if (result.renamed) {
      console.log(`✅→ ${result.newName.slice(0, 35)}`);
      success++;
      renamed++;
    } else {
      console.log('✅ 上書き完了');
      success++;
    }

    // 5件ごとに進捗サマリ
    if ((i + 1) % 5 === 0) {
      console.log(`  --- ${success}完了 / ${failed}失敗 / ${renamed}リネーム ---`);
    }
  }

  console.log('');
  console.log('═'.repeat(60));
  console.log(`完了: ${success}件 / エラー: ${failed}件 / リネーム: ${renamed}件`);
  console.log('═'.repeat(60));
}

main().catch(console.error);
