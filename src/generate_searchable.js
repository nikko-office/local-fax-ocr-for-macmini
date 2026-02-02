#!/usr/bin/env node
/**
 * Generate Searchable PDFs for files that have OCR but no searchable PDF
 *
 * Incremental processing - only processes missing files
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function generateSearchablePdf(ocrJsonPath, pngPath, outputDir) {
  const basename = path.basename(ocrJsonPath, '.ocr.json');
  const searchablePdfPath = path.join(outputDir, `${basename}.searchable.pdf`);

  // Skip if already exists
  if (await fileExists(searchablePdfPath)) {
    return { status: 'skipped', reason: 'already exists' };
  }

  // Check if PNG exists
  if (!await fileExists(pngPath)) {
    return { status: 'error', reason: 'PNG not found' };
  }

  // Run Python script
  const pythonScript = path.join(__dirname, '..', 'py', 'searchable_pdf.py');

  return new Promise((resolve) => {
    const proc = spawn('python3', [
      pythonScript,
      '--input-pdf', pngPath,
      '--ocr-json', ocrJsonPath,
      '--output-pdf', searchablePdfPath
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ status: 'created', path: searchablePdfPath });
      } else {
        resolve({ status: 'error', reason: stderr.slice(0, 200) });
      }
    });

    proc.on('error', (err) => {
      resolve({ status: 'error', reason: err.message });
    });
  });
}

async function main() {
  const outputDir = process.argv[2] || './output';

  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║     Searchable PDF Generator (Incremental)         ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // Find all OCR JSON files
  const files = await fs.readdir(outputDir);
  const ocrFiles = files.filter(f => f.endsWith('.ocr.json'));

  console.log(`Found ${ocrFiles.length} OCR files\n`);

  const results = {
    created: [],
    skipped: [],
    errors: []
  };

  for (const ocrFile of ocrFiles) {
    const basename = ocrFile.replace('.ocr.json', '');
    const ocrPath = path.join(outputDir, ocrFile);
    const pngPath = path.join(outputDir, `${basename}.png`);

    process.stdout.write(`Processing: ${basename.slice(0, 40).padEnd(40)}... `);

    const result = await generateSearchablePdf(ocrPath, pngPath, outputDir);

    if (result.status === 'created') {
      console.log('✅ Created');
      results.created.push(basename);
    } else if (result.status === 'skipped') {
      console.log('⏭️  Skipped');
      results.skipped.push(basename);
    } else {
      console.log(`❌ Error: ${result.reason}`);
      results.errors.push({ name: basename, reason: result.reason });
    }
  }

  // Report
  console.log('\n' + '═'.repeat(60));
  console.log('処理結果レポート');
  console.log('═'.repeat(60));
  console.log(`✅ Searchable PDF生成: ${results.created.length}件`);
  console.log(`⏭️  スキップ（既存）: ${results.skipped.length}件`);
  console.log(`❌ エラー: ${results.errors.length}件`);

  if (results.errors.length > 0) {
    console.log('\nエラー詳細:');
    for (const err of results.errors) {
      console.log(`  - ${err.name}: ${err.reason}`);
    }
  }

  console.log('\n' + '═'.repeat(60));
}

main().catch(console.error);
