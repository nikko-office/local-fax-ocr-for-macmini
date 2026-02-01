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

import { performOcr } from './ocr_provider.js';
import { computeFileHash } from './vision_ocr.js';
import { createOcrDocument, extractFullText } from './ocr_schema.js';
import { suggestRename } from './rename_suggest.js';
import { runPythonScript } from './python_runner.js';
import { refineOcrText, refineOcrTextByLines, isLlmEnabled, checkLlmHealth, runTwoModelInference, runVisionInference } from './local_llm.js';

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
    'llm-refine': { type: 'boolean', default: false },
    'llm-refine-mode': { type: 'string', default: 'text' },
    'searchable-pdf': { type: 'boolean', default: false },
    'font-path': { type: 'string' },
    'skip-ocr': { type: 'boolean', default: false },
    'llm-rename': { type: 'boolean', default: false },
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
      llmRefine: values['llm-refine'],
      llmRefineMode: values['llm-refine-mode'],
      searchablePdf: values['searchable-pdf'],
      fontPath: values['font-path'],
      skipOcr: values['skip-ocr'],
      llmRename: values['llm-rename'],
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
  --llm-refine        Local LLMでOCRテキストを整形（誤字修正・改行整理）
  --llm-refine-mode   LLM整形モード: text | lines (default: text)
                        text: raw_textのみ更新（bbox非同期）
                        lines: 各行のtextを更新（bbox同期、searchable-pdf向け）
  --llm-rename        2モデル推論でリネーム精度向上（Gemma3→Qwen3）
  --searchable-pdf    透明テキスト重畳のPDFを生成
  --font-path <path>  日本語フォントファイルパス（searchable-pdf用）
  -h, --help          ヘルプを表示
  -v, --version       バージョンを表示

Environment:
  OCR_PROVIDER          OCRプロバイダー: local | google | auto (default: local)
  LOCAL_OCR_API_URL     Local OCR API URL (default: http://localhost:8765)
  GOOGLE_CLOUD_API_KEY  Google Cloud Vision API キー (OCR_PROVIDER=google時のみ)
  GEMINI_API_KEY        Gemini API キー (--gemini使用時のみ)
  LLM_ENABLED           LLM整形の有効/無効: true | false (default: false)
  LOCAL_LLM_API_URL     Local LLM API URL (default: http://localhost:1234/v1)
  LOCAL_LLM_MODEL       LLMモデル名 (default: gemma3)

Prerequisites (完全オフライン運用):
  docker-compose up -d  # PaddleOCR APIを起動

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
    llm_refined: null,
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
    let imagePath = filePath; // Track image path for vision inference

    // Check if we should skip OCR
    if (args.skipOcr && await fileExists(ocrOutputPath)) {
      log('info', `  Using existing OCR result: ${basename}.ocr.json`);
      ocrDoc = await readJson(ocrOutputPath);
      // Try to find existing PNG for vision inference
      const pngPath = path.join(args.outputDir, `${basename}.png`);
      if (await fileExists(pngPath)) {
        imagePath = pngPath;
      }
    } else {
      // Validate API key for OCR (only required for non-local providers)
      const ocrProvider = process.env.OCR_PROVIDER || 'local';
      if (!apiKey && ocrProvider !== 'local') {
        throw new Error('GOOGLE_CLOUD_API_KEY is required (set OCR_PROVIDER=local for offline mode)');
      }

      // Convert PDF to PNG if needed
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
        log('info', `  Calling OCR API (${ocrProvider})...`);
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

    // LLM refinement (optional)
    if (args.llmRefine && isLlmEnabled()) {
      const mode = args.llmRefineMode || 'text';
      log('info', `  Running LLM text refinement (mode=${mode})...`);

      // Check LLM health first
      const llmHealthy = await checkLlmHealth();
      if (!llmHealthy) {
        log('warn', `  LLM API not available, skipping refinement`);
      } else if (mode === 'lines') {
        // Mode: lines - update each line's text while preserving bbox
        const allLines = [];
        const lineRefs = []; // Keep references to original line objects

        for (const page of ocrDoc.pages) {
          for (const block of page.blocks) {
            for (const line of block.lines) {
              allLines.push(line.text);
              lineRefs.push(line);
            }
          }
        }

        if (allLines.length === 0) {
          log('warn', `  No lines found in OCR document`);
        } else {
          const llmResult = await refineOcrTextByLines(allLines);

          if (llmResult.success) {
            // Apply refined text to each line (bbox preserved)
            for (let i = 0; i < lineRefs.length; i++) {
              lineRefs[i].text = llmResult.lines[i];
            }
            // Also update raw_text
            ocrDoc.raw_text = llmResult.lines.join('\n');
            ocrDoc.llm_refined = true;
            ocrDoc.llm_refine_mode = 'lines';

            await writeJson(ocrOutputPath, ocrDoc);
            log('info', `  LLM refinement complete (${allLines.length} lines)`);
            result.llm_refined = true;
          } else {
            log('warn', `  LLM refinement failed: ${llmResult.error}`);
            result.llm_refined = false;
          }
        }
      } else {
        // Mode: text (default) - update raw_text only
        const rawText = extractFullText(ocrDoc);
        const llmResult = await refineOcrText(rawText);

        if (llmResult.success) {
          ocrDoc.raw_text = llmResult.text;
          ocrDoc.llm_refined = true;
          ocrDoc.llm_refine_mode = 'text';

          await writeJson(ocrOutputPath, ocrDoc);
          log('info', `  LLM refinement complete`);
          result.llm_refined = true;
        } else {
          log('warn', `  LLM refinement failed: ${llmResult.error}`);
          result.llm_refined = false;
        }
      }
    }

    // Generate rename suggestion
    const fullText = extractFullText(ocrDoc);
    let llmExtraction = null;

    // Vision + 2モデル推論でリネーム精度向上 (optional)
    if (args.llmRename) {
      log('info', `  Running vision inference for rename...`);
      const llmHealthy = await checkLlmHealth();
      if (!llmHealthy) {
        log('warn', `  LLM API not available, falling back to rule-based rename`);
      } else {
        // Use vision inference if image is available, otherwise fallback to text-only
        const inferResult = await runVisionInference(fullText, imagePath);
        if (inferResult.success && inferResult.data) {
          llmExtraction = inferResult.data;
          const mode = inferResult.pipeline?.includes('vision:success') ? 'vision' : 'text';
          log('info', `  ${mode} inference: date=${llmExtraction.date || 'null'}, docType=${llmExtraction.docType || 'null'}, company=${llmExtraction.company || 'null'}`);
        } else {
          log('warn', `  Vision inference failed: ${inferResult.error}`);
        }
      }
    }

    const renameSuggestion = suggestRename(fullText, path.basename(filePath), llmExtraction);

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
  const ocrProvider = process.env.OCR_PROVIDER || 'google';
  if (!apiKey && !args.skipOcr && ocrProvider !== 'local') {
    console.error('Error: GOOGLE_CLOUD_API_KEY environment variable is not set.');
    console.error('Please set it in your .env file or environment.');
    console.error('Alternatively, set OCR_PROVIDER=local to use Local OCR API.');
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
