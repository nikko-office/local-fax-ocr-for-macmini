#!/usr/bin/env node
/**
 * Watch Mode - Real-time file monitoring and auto-rename
 *
 * Monitors a folder for new PDF files and automatically processes them
 * when they don't start with YYYYMMDD_ pattern.
 */

import { watch } from 'chokidar';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Date pattern: starts with 8 digits followed by underscore
const DATED_PATTERN = /^[0-9]{8}_/;

// Processing queue to avoid concurrent processing
const processingQueue = new Set();

/**
 * Check if file needs processing (not dated)
 */
function needsProcessing(filename) {
  const basename = path.basename(filename);
  return basename.endsWith('.pdf') && !DATED_PATTERN.test(basename);
}

/**
 * Process a single file
 */
async function processFile(filePath, outputDir) {
  const basename = path.basename(filePath);

  // Skip if already processing
  if (processingQueue.has(filePath)) {
    return;
  }

  processingQueue.add(filePath);
  console.log(`[${new Date().toISOString()}] 🔄 Processing: ${basename}`);

  try {
    const mainScript = path.join(__dirname, 'main.js');

    const result = await new Promise((resolve, reject) => {
      const proc = spawn('node', [
        mainScript,
        'process',
        '--in', filePath,
        '--out', outputDir,
        '--llm-rename',
        '--apply-rename'
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
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
          reject(new Error(`Process exited with code ${code}\n${stderr}`));
        }
      });

      proc.on('error', reject);
    });

    // Extract rename info from output
    const renameMatch = result.stdout.match(/Renamed: .+ -> (.+\.pdf)/);
    if (renameMatch) {
      console.log(`[${new Date().toISOString()}] ✅ Renamed to: ${renameMatch[1]}`);
    } else {
      console.log(`[${new Date().toISOString()}] ✅ Processed: ${basename}`);
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error processing ${basename}: ${error.message}`);
  } finally {
    processingQueue.delete(filePath);
  }
}

/**
 * Scan existing files and process undated ones
 */
async function scanExisting(watchDir, outputDir) {
  console.log(`\n📁 Scanning existing files in: ${watchDir}\n`);

  const files = await fs.readdir(watchDir);
  const pdfFiles = files.filter(f => f.endsWith('.pdf'));
  const undatedFiles = pdfFiles.filter(f => needsProcessing(f));

  console.log(`Found ${pdfFiles.length} PDFs, ${undatedFiles.length} need processing\n`);

  for (const file of undatedFiles) {
    const filePath = path.join(watchDir, file);
    await processFile(filePath, outputDir);
  }
}

/**
 * Main watch function
 */
async function startWatching(watchDir, outputDir, options = {}) {
  const { scanOnStart = true } = options;

  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║           FAX OCR Watch Mode                       ║');
  console.log('╠════════════════════════════════════════════════════╣');
  console.log(`║ Watch: ${watchDir.slice(-45).padEnd(45)}║`);
  console.log(`║ Output: ${outputDir.slice(-44).padEnd(44)}║`);
  console.log('╚════════════════════════════════════════════════════╝');
  console.log('\n👁️  Watching for new/changed PDF files...');
  console.log('   (Only files NOT starting with YYYYMMDD_ will be processed)');
  console.log('   Press Ctrl+C to stop\n');

  // Scan existing files first if requested
  if (scanOnStart) {
    await scanExisting(watchDir, outputDir);
    console.log('\n👁️  Continuing to watch for new files...\n');
  }

  // Set up watcher
  const watcher = watch(path.join(watchDir, '*.pdf'), {
    persistent: true,
    ignoreInitial: true,  // Don't fire for existing files
    awaitWriteFinish: {
      stabilityThreshold: 2000,  // Wait 2s after last write
      pollInterval: 100
    }
  });

  // Handle new files
  watcher.on('add', async (filePath) => {
    if (needsProcessing(filePath)) {
      console.log(`\n📥 New file detected: ${path.basename(filePath)}`);
      await processFile(filePath, outputDir);
    } else {
      console.log(`\n✓ Skipped (already dated): ${path.basename(filePath)}`);
    }
  });

  // Handle changed files (re-process if undated)
  watcher.on('change', async (filePath) => {
    if (needsProcessing(filePath)) {
      console.log(`\n📝 File changed: ${path.basename(filePath)}`);
      await processFile(filePath, outputDir);
    }
  });

  watcher.on('error', (error) => {
    console.error(`\n❌ Watch error: ${error.message}`);
  });

  // Keep process alive
  process.on('SIGINT', () => {
    console.log('\n\n👋 Stopping watch mode...');
    watcher.close();
    process.exit(0);
  });
}

// CLI
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node src/watch.js <watch-directory> [output-directory]

Options:
  --no-scan    Don't process existing files on start
  -h, --help   Show this help

Examples:
  node src/watch.js ./FAX1NEW ./output
  node src/watch.js "/path/to/fax/folder" --no-scan
`);
  process.exit(0);
}

const watchDir = args.find(a => !a.startsWith('-')) || './input';
const outputDir = args.filter(a => !a.startsWith('-'))[1] || './output/watch';
const noScan = args.includes('--no-scan');

// Ensure output directory exists
await fs.mkdir(outputDir, { recursive: true });

// Start watching
startWatching(watchDir, outputDir, { scanOnStart: !noScan });
