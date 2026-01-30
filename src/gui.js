#!/usr/bin/env node
/**
 * FaxOCR-JS - Web GUI Server
 *
 * シンプルなWeb UIでOCR処理を実行
 *
 * Usage:
 *   node src/gui.js [--port <port>]
 *   npm run gui
 */

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import {
  isPdf,
  pdfToPng,
  ensureDir,
  writeJson,
  readJson,
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

// Default port
const DEFAULT_PORT = 3000;

// Upload directory
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// Setup multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await ensureDir(UPLOAD_DIR);
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    // Preserve original filename with timestamp prefix
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${timestamp}_${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /pdf|png|jpg|jpeg|tiff|bmp|gif/i;
    const ext = path.extname(file.originalname).slice(1);
    if (allowedTypes.test(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type'));
    }
  }
});

/**
 * Process a file with OCR
 */
async function processFile(filePath, options = {}) {
  const apiKey = process.env.GOOGLE_CLOUD_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_CLOUD_API_KEY is not set');
  }

  const basename = getStem(filePath);
  await ensureDir(OUTPUT_DIR);

  const result = {
    status: 'ok',
    input_file: filePath,
    original_name: path.basename(filePath),
    job_dir: OUTPUT_DIR,
    ocr_json: null,
    rename_json: null,
    gemini_md: null,
    searchable_pdf: null,
    raw_text: null,
    rename: null
  };

  // Convert PDF to PNG if needed
  let imagePath = filePath;
  if (isPdf(filePath)) {
    imagePath = await pdfToPng(filePath, OUTPUT_DIR, options.dpi || 300);
  }

  // Compute hash
  const hash = await computeFileHash(imagePath);

  // Get image dimensions
  const dimensions = await getImageDimensions(imagePath);

  // Perform OCR
  const visionResponse = await performOcr(imagePath, apiKey);

  // Create OcrDocument
  const ocrDoc = createOcrDocument(
    visionResponse,
    path.basename(filePath),
    hash,
    dimensions.width,
    dimensions.height
  );

  // Save OCR result
  const ocrOutputPath = path.join(OUTPUT_DIR, `${basename}.ocr.json`);
  await writeJson(ocrOutputPath, ocrDoc);
  result.ocr_json = ocrOutputPath;
  result.raw_text = ocrDoc.raw_text;

  // Generate rename suggestion
  const fullText = extractFullText(ocrDoc);
  const renameSuggestion = suggestRename(fullText, path.basename(filePath));

  // Save rename suggestion
  const renameOutputPath = path.join(OUTPUT_DIR, `${basename}.rename.json`);
  await writeJson(renameOutputPath, renameSuggestion);
  result.rename_json = renameOutputPath;
  result.rename = renameSuggestion;

  // Gemini formatting (optional)
  if (options.gemini && process.env.GEMINI_API_KEY) {
    try {
      const geminiOutputPath = path.join(OUTPUT_DIR, `${basename}.gemini.md`);
      await runPythonScript('gemini_format.py', [
        '--ocr-json', ocrOutputPath,
        '--output-md', geminiOutputPath
      ], {
        GEMINI_API_KEY: process.env.GEMINI_API_KEY
      });
      result.gemini_md = geminiOutputPath;
    } catch (error) {
      console.error('Gemini formatting failed:', error.message);
    }
  }

  // Searchable PDF (optional)
  if (options.searchablePdf && isPdf(filePath) && options.fontPath) {
    try {
      const searchablePdfPath = path.join(OUTPUT_DIR, `${basename}.searchable.pdf`);
      await runPythonScript('searchable_pdf.py', [
        '--input-pdf', filePath,
        '--ocr-json', ocrOutputPath,
        '--dpi', String(options.dpi || 300),
        '--output-pdf', searchablePdfPath,
        '--font-path', options.fontPath
      ]);
      result.searchable_pdf = searchablePdfPath;
    } catch (error) {
      console.error('Searchable PDF generation failed:', error.message);
    }
  }

  return result;
}

/**
 * Create Express app
 */
function createApp() {
  const app = express();

  // Serve static files
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));
  app.use('/output', express.static(OUTPUT_DIR));

  // JSON body parser
  app.use(express.json());

  // API: Upload and process file
  app.post('/api/process', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const options = {
        dpi: parseInt(req.body.dpi) || 300,
        gemini: req.body.gemini === 'true',
        searchablePdf: req.body.searchablePdf === 'true',
        fontPath: req.body.fontPath || null
      };

      const result = await processFile(req.file.path, options);

      res.json(result);
    } catch (error) {
      console.error('Processing error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // API: Get OCR result
  app.get('/api/ocr/:filename', async (req, res) => {
    try {
      const ocrPath = path.join(OUTPUT_DIR, `${req.params.filename}.ocr.json`);
      if (await fileExists(ocrPath)) {
        const data = await readJson(ocrPath);
        res.json(data);
      } else {
        res.status(404).json({ error: 'OCR result not found' });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // API: Get Gemini markdown
  app.get('/api/gemini/:filename', async (req, res) => {
    try {
      const mdPath = path.join(OUTPUT_DIR, `${req.params.filename}.gemini.md`);
      if (await fileExists(mdPath)) {
        const content = await fs.readFile(mdPath, 'utf-8');
        res.type('text/markdown').send(content);
      } else {
        res.status(404).json({ error: 'Gemini result not found' });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // API: Apply rename
  app.post('/api/rename', async (req, res) => {
    try {
      const { originalPath, newName } = req.body;
      if (!originalPath || !newName) {
        return res.status(400).json({ error: 'Missing originalPath or newName' });
      }

      const dir = path.dirname(originalPath);
      const ext = path.extname(originalPath);
      const newPath = path.join(dir, `${newName}${ext}`);

      await fs.rename(originalPath, newPath);

      res.json({ success: true, newPath });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // API: Check environment
  app.get('/api/status', (req, res) => {
    res.json({
      hasVisionApiKey: !!process.env.GOOGLE_CLOUD_API_KEY,
      hasGeminiApiKey: !!process.env.GEMINI_API_KEY
    });
  });

  // Error handler
  app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({ error: error.message });
  });

  return app;
}

/**
 * Start server
 */
async function main() {
  // Parse args
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
    }
  }

  // Ensure directories
  await ensureDir(UPLOAD_DIR);
  await ensureDir(OUTPUT_DIR);

  // Create and start server
  const app = createApp();
  const server = createServer(app);

  server.listen(port, () => {
    console.log(`
  ╔════════════════════════════════════════════╗
  ║         FaxOCR-JS Web GUI                  ║
  ╠════════════════════════════════════════════╣
  ║  Server running at:                        ║
  ║  http://localhost:${port.toString().padEnd(25)}║
  ║                                            ║
  ║  Press Ctrl+C to stop                      ║
  ╚════════════════════════════════════════════╝
`);
  });
}

main().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
