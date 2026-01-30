#!/usr/bin/env node
/**
 * FaxOCR-JS - CLI Entry Point
 *
 * FAX受信PDF/画像をGoogle Vision APIでOCRし、
 * リネーム候補を提案するツール
 *
 * Usage:
 *   node src/main.js [options]
 *   node src/main.js process --in <file> [options]
 */

import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  isPdf,
  pdfToPng,
  listInputFiles,
  ensureDir,
  writeJson,
  readJson,
  checkCacheHit,
  writeHashCache,
  applyRename,
  getStem,
  getImageDimensions,
  fileExists
} from './io.js';

import { performOcr, computeFileHash } from './vision_ocr.js';
import { createOcrDocument, extractFullText } from './ocr_schema.js';
import { suggestRename } from './rename_suggest.js';
import { runPythonScript } from './python_runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Exit codes
const EXIT_SUCCESS = 0;
const EXIT_CONFIG_ERROR = 1;
const EXIT_INPUT_ERROR = 2;
// const EXIT_API_ERROR = 3;
// const EXIT_IO_ERROR = 4;

/**
 * Parse CLI arguments
 */
function parseCliArgs() {
  const args = process.argv.slice(2);

  // Check for 'process' subcommand
  const isProcessCommand = args[0] === 'process';
  const argsToProcess = isProcessCommand ? args.slice(1) : args;

  const options = {
    in: { type: 'string', default: isProcessCommand ? undefined : './input' },
    out: { type: 'string', default: './output' },
    'apply-rename': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    dpi: { type: 'string', default: '300' },
    gemini: { type: 'boolean', default: false },
    'searchable-pdf': { type: 'boolean', default: false },
    'font-path': { type: 'string' },
    'skip-ocr': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false }
  };

  try {
    const { values } = parseArgs({ options, args: argsToProcess, allowPositionals: false });
    return {
      command: isProcessCommand ? 'process' : 'batch',
      inputPath: values.in,
      outputDir: values.out,
      applyRename: values['apply-rename'],
      force: values.force,
      dpi: parseInt(values.dpi, 10),
      gemini: values.gemini,
      searchablePdf: values['searchable-pdf'],
      fontPath: values['font-path'],
      skipOcr: values['skip-ocr'],
      help: values.help,
      version: values.version
    };
  } catch (error) {
    console.error(`Error: ${error.message}`);
    printUsage();
    process.exit(EXIT_CONFIG_ERROR);
  }
}

/**
 * Print usage information
 */
function printUsage() {
  console.log(`
FaxOCR-JS - FAX PDF/画像のOCR & リネーム提案ツール

Usage:
  node src/main.js [options]                    # バッチ処理（フォルダ）
  node src/main.js process --in <file> [options]  # 単一ファイル処理

Options:
  --in <path>         入力ファイル/ディレクトリ (default: ./input)
  --out <dir>         出力ディレクトリ (default: ./output)
  --apply-rename      リネーム提案を実際に適用する
  --force             キャッシュを無視して再OCR
  --dpi <number>      PDF変換時のDPI (default: 300)
  --skip-ocr          既存の.ocr.jsonがあれば再利用
  --gemini            Gemini APIでMarkdown整形を実行
  --searchable-pdf    透明テキスト重畳のPDFを生成
  --font-path <path>  日本語フォントファイルパス（searchable-pdf用）
  -h, --help          ヘルプを表示
  -v, --version       バージョンを表示

Environment:
  GOOGLE_CLOUD_API_KEY  Google Cloud Vision API キー (必須)
  GEMINI_API_KEY        Gemini API キー (--gemini使用時に必須)

Examples:
  # フォルダ内の全ファイルをOCR
  node src/main.js --in ./faxes --out ./results

  # 単一ファイルをOCR + Gemini整形 + searchable PDF
  node src/main.js process --in ./fax.pdf --out ./output --gemini --searchable-pdf

  # 既存OCR結果からsearchable PDFのみ生成
  node src/main.js process --in ./fax.pdf --out ./output --skip-ocr --searchable-pdf
`);
}

/**
 * Print version
 */
function printVersion() {
  console.log('faxocr-js v1.1.0');
}

/**
 * Log with timestamp
 */
function log(level, message) {
  const timestamp = new Date().toISOString();
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '✅';
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

/**
 * Process a single file (process command)
 */
async function processSingleFile(filePath, args, apiKey) {
  const basename = getStem(filePath);
  const result = {
    status: 'ok',
    input_file: filePath,
    job_dir: args.outputDir,
    ocr_json: null,
    rename_json: null,
    gemini_md: null,
    searchable_pdf: null
  };

  try {
    log('info', `Processing: ${path.basename(filePath)}`);

    // Prepare output directory
    await ensureDir(args.outputDir);

    const ocrOutputPath = path.join(args.outputDir, `${basename}.ocr.json`);
    const renameOutputPath = path.join(args.outputDir, `${basename}.rename.json`);
    let ocrDoc;

    // Check if we should skip OCR
    if (args.skipOcr && await fileExists(ocrOutputPath)) {
      log('info', `  Using existing OCR result: ${basename}.ocr.json`);
      ocrDoc = await readJson(ocrOutputPath);
    } else {
      // Validate API key for OCR
      if (!apiKey) {
        throw new Error('GOOGLE_CLOUD_API_KEY is required for OCR');
      }

      // Convert PDF to PNG if needed
      let imagePath = filePath;
      if (isPdf(filePath)) {
        log('info', `  Converting PDF to PNG (${args.dpi} DPI)...`);
        imagePath = await pdfToPng(filePath, args.outputDir, args.dpi);
      }

      // Compute hash for caching
      const hash = await computeFileHash(imagePath);
      const hashFilePath = path.join(args.outputDir, `${basename}.sha256`);

      // Check cache
      if (!args.force && await checkCacheHit(hashFilePath, hash) && await fileExists(ocrOutputPath)) {
        log('info', `  Using cached OCR result`);
        ocrDoc = await readJson(ocrOutputPath);
      } else {
        // Get image dimensions
        const dimensions = await getImageDimensions(imagePath);

        // Perform OCR
        log('info', `  Calling Vision API...`);
        const visionResponse = await performOcr(imagePath, apiKey);

        // Create OcrDocument
        ocrDoc = createOcrDocument(
          visionResponse,
          path.basename(filePath),
          hash,
          dimensions.width,
          dimensions.height
        );

        // Save OCR result
        await writeJson(ocrOutputPath, ocrDoc);
        log('info', `  Saved: ${basename}.ocr.json`);

        // Update cache
        await writeHashCache(hashFilePath, hash);
      }
    }

    result.ocr_json = ocrOutputPath;

    // Generate rename suggestion
    const fullText = extractFullText(ocrDoc);
    const renameSuggestion = suggestRename(fullText, path.basename(filePath));

    // Save rename suggestion
    await writeJson(renameOutputPath, renameSuggestion);
    log('info', `  Suggestion: ${renameSuggestion.stem} (confidence: ${renameSuggestion.confidence})`);
    result.rename_json = renameOutputPath;
    result.rename = renameSuggestion;

    // Gemini formatting (optional)
    if (args.gemini) {
      const geminiApiKey = process.env.GEMINI_API_KEY;
      if (!geminiApiKey) {
        log('warn', `  Skipping Gemini: GEMINI_API_KEY not set`);
      } else {
        log('info', `  Running Gemini formatting...`);
        const geminiOutputPath = path.join(args.outputDir, `${basename}.gemini.md`);

        try {
          await runPythonScript('gemini_format.py', [
            '--ocr-json', ocrOutputPath,
            '--output-md', geminiOutputPath
          ], {
            GEMINI_API_KEY: geminiApiKey
          });
          result.gemini_md = geminiOutputPath;
          log('info', `  Saved: ${basename}.gemini.md`);
        } catch (error) {
          log('error', `  Gemini failed: ${error.message}`);
        }
      }
    }

    // Searchable PDF (optional)
    if (args.searchablePdf) {
      if (!isPdf(filePath)) {
        log('warn', `  Skipping searchable PDF: input is not PDF`);
      } else {
        log('info', `  Generating searchable PDF...`);
        const searchablePdfPath = path.join(args.outputDir, `${basename}.searchable.pdf`);

        const pythonArgs = [
          '--input-pdf', filePath,
          '--ocr-json', ocrOutputPath,
          '--dpi', String(args.dpi),
          '--output-pdf', searchablePdfPath
        ];

        if (args.fontPath) {
          pythonArgs.push('--font-path', args.fontPath);
        }

        try {
          await runPythonScript('searchable_pdf.py', pythonArgs);
          result.searchable_pdf = searchablePdfPath;
          log('info', `  Saved: ${basename}.searchable.pdf`);
        } catch (error) {
          log('error', `  Searchable PDF failed: ${error.message}`);
        }
      }
    }

    // Apply rename if requested
    if (args.applyRename && renameSuggestion.confidence >= 0.5) {
      const newPath = await applyRename(filePath, renameSuggestion.stem);
      log('info', `  Renamed: ${path.basename(filePath)} -> ${path.basename(newPath)}`);
    }

    return result;

  } catch (error) {
    log('error', `  Failed: ${error.message}`);
    return {
      status: 'error',
      input_file: filePath,
      error: error.message
    };
  }
}

/**
 * Process batch (original behavior)
 */
async function processBatch(args, apiKey) {
  // List input files
  let files;
  try {
    files = await listInputFiles(args.inputPath);
  } catch (error) {
    console.error(`Error: Cannot read input directory: ${args.inputPath}`);
    console.error(error.message);
    process.exit(EXIT_INPUT_ERROR);
  }

  if (files.length === 0) {
    console.log(`No supported files found in ${args.inputPath}`);
    console.log('Supported formats: PDF, PNG, JPG, JPEG, TIFF, BMP, GIF');
    process.exit(EXIT_SUCCESS);
  }

  console.log(`Found ${files.length} file(s) to process`);
  console.log('');

  // Process each file
  const results = [];
  for (const file of files) {
    const result = await processSingleFile(file, args, apiKey);
    results.push(result);
    console.log('');
  }

  // Print summary
  console.log('='.repeat(50));
  console.log('Summary:');

  const successful = results.filter(r => r.status === 'ok');
  const failed = results.filter(r => r.status === 'error');

  console.log(`  Processed: ${successful.length}`);
  console.log(`  Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log('');
    console.log('Failed files:');
    for (const f of failed) {
      console.log(`  - ${f.input_file}: ${f.error}`);
    }
  }

  // Exit with error code if any failures
  process.exit(failed.length > 0 ? 1 : EXIT_SUCCESS);
}

/**
 * Main entry point
 */
async function main() {
  const args = parseCliArgs();

  // Handle help/version
  if (args.help) {
    printUsage();
    process.exit(EXIT_SUCCESS);
  }

  if (args.version) {
    printVersion();
    process.exit(EXIT_SUCCESS);
  }

  // Get API key
  const apiKey = process.env.GOOGLE_CLOUD_API_KEY;

  // Handle 'process' command (single file, JSON output)
  if (args.command === 'process') {
    if (!args.inputPath) {
      console.error('Error: --in <file> is required for process command');
      process.exit(EXIT_CONFIG_ERROR);
    }

    // Check if input exists
    try {
      await fs.access(args.inputPath);
    } catch {
      console.error(`Error: Input file not found: ${args.inputPath}`);
      process.exit(EXIT_INPUT_ERROR);
    }

    const result = await processSingleFile(args.inputPath, args, apiKey);

    // Output JSON to stdout
    console.log(JSON.stringify(result, null, 2));

    process.exit(result.status === 'ok' ? EXIT_SUCCESS : 1);
  }

  // Handle batch mode
  if (!apiKey && !args.skipOcr) {
    console.error('Error: GOOGLE_CLOUD_API_KEY environment variable is not set.');
    console.error('Please set it in your .env file or environment.');
    process.exit(EXIT_CONFIG_ERROR);
  }

  // Default input path for batch mode
  if (!args.inputPath) {
    args.inputPath = './input';
  }

  await processBatch(args, apiKey);
}

// Run main
main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
