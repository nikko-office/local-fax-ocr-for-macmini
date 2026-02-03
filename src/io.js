/**
 * I/O Utilities - ファイル操作基盤
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Supported file extensions
const PDF_EXTENSIONS = ['.pdf'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif'];

/**
 * Check if file is PDF
 * @param {string} filePath
 * @returns {boolean}
 */
export function isPdf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return PDF_EXTENSIONS.includes(ext);
}

/**
 * Check if file is supported image
 * @param {string} filePath
 * @returns {boolean}
 */
export function isImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Check if file is supported input format
 * @param {string} filePath
 * @returns {boolean}
 */
export function isSupportedInput(filePath) {
  return isPdf(filePath) || isImage(filePath);
}

/**
 * Ensure directory exists
 * @param {string} dirPath
 */
export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Write JSON to file with pretty formatting
 * @param {string} filePath
 * @param {Object} data
 */
export async function writeJson(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, json, 'utf-8');
}

/**
 * Read JSON from file
 * @param {string} filePath
 * @returns {Promise<Object>}
 */
export async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * List supported input files in directory
 * @param {string} dirPath
 * @returns {Promise<string[]>} - Array of absolute paths
 */
export async function listInputFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isFile()) {
      const filePath = path.join(dirPath, entry.name);
      if (isSupportedInput(filePath)) {
        files.push(filePath);
      }
    }
  }

  // Sort by filename for deterministic order
  files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return files;
}

/**
 * Convert PDF first page to PNG using pdftocairo
 * @param {string} pdfPath - Input PDF path
 * @param {string} outputDir - Output directory
 * @param {number} dpi - Resolution (default: 200)
 * @param {string} outputBasename - Output basename (default: derived from pdfPath)
 * @returns {Promise<string>} - Path to generated PNG
 */
export async function pdfToPng(pdfPath, outputDir, dpi = 200, outputBasename = null) {
  await ensureDir(outputDir);

  const basename = outputBasename || path.basename(pdfPath, path.extname(pdfPath));
  const outputPath = path.join(outputDir, `${basename}.png`);

  // pdftocairo -png -r <dpi> -f 1 -l 1 input.pdf output_prefix
  // Output will be output_prefix-1.png
  const outputPrefix = path.join(outputDir, basename);

  try {
    await execFileAsync('pdftocairo', [
      '-png',
      '-r', String(dpi),
      '-f', '1',  // first page
      '-l', '1',  // last page (same as first = single page)
      '-singlefile',  // don't add page number suffix
      pdfPath,
      outputPrefix
    ]);

    // With -singlefile, output is exactly outputPrefix.png
    const expectedOutput = `${outputPrefix}.png`;

    // Verify output exists
    await fs.access(expectedOutput);
    return expectedOutput;

  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('pdftocairo not found. Please install poppler-utils.');
    }
    throw new Error(`PDF conversion failed: ${error.message}`);
  }
}

/**
 * Get image dimensions using identify (ImageMagick) or fallback
 * @param {string} imagePath
 * @returns {Promise<{width: number, height: number}>}
 */
export async function getImageDimensions(imagePath) {
  try {
    // Try using 'identify' from ImageMagick
    const { stdout } = await execFileAsync('identify', ['-format', '%w %h', imagePath]);
    const [width, height] = stdout.trim().split(' ').map(Number);
    return { width, height };
  } catch {
    // Fallback: try using 'sips' on macOS
    try {
      const { stdout } = await execFileAsync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', imagePath]);
      const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
      const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);
      if (widthMatch && heightMatch) {
        return {
          width: parseInt(widthMatch[1], 10),
          height: parseInt(heightMatch[1], 10)
        };
      }
    } catch {
      // Ignore
    }

    // Final fallback: return default dimensions
    console.warn(`Warning: Could not determine image dimensions for ${imagePath}, using defaults`);
    return { width: 2480, height: 3508 }; // A4 at 300 DPI
  }
}

/**
 * Check if hash file matches given hash
 * @param {string} hashFilePath
 * @param {string} currentHash
 * @returns {Promise<boolean>}
 */
export async function checkCacheHit(hashFilePath, currentHash) {
  try {
    const storedHash = await fs.readFile(hashFilePath, 'utf-8');
    return storedHash.trim() === currentHash.trim();
  } catch {
    return false;
  }
}

/**
 * Write hash to cache file
 * @param {string} hashFilePath
 * @param {string} hash
 */
export async function writeHashCache(hashFilePath, hash) {
  await fs.writeFile(hashFilePath, hash, 'utf-8');
}

/**
 * Apply rename (move file)
 * @param {string} oldPath - Original file path
 * @param {string} newStem - New filename stem (without extension)
 * @returns {Promise<string>} - New path
 */
export async function applyRename(oldPath, newStem) {
  const dir = path.dirname(oldPath);
  const ext = path.extname(oldPath);
  const newPath = path.join(dir, `${newStem}${ext}`);

  // Don't rename if same
  if (oldPath === newPath) {
    return oldPath;
  }

  // Check if target exists
  try {
    await fs.access(newPath);
    // Target exists, add suffix
    let suffix = 1;
    let uniquePath;
    do {
      uniquePath = path.join(dir, `${newStem}_${suffix}${ext}`);
      suffix++;
      try {
        await fs.access(uniquePath);
      } catch {
        break; // File doesn't exist, use this path
      }
    } while (suffix < 100);

    await fs.rename(oldPath, uniquePath);
    return uniquePath;
  } catch {
    // Target doesn't exist, proceed with rename
    await fs.rename(oldPath, newPath);
    return newPath;
  }
}

/**
 * Copy file
 * @param {string} srcPath
 * @param {string} destPath
 */
export async function copyFile(srcPath, destPath) {
  await fs.copyFile(srcPath, destPath);
}

/**
 * Check if file exists
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file stem (filename without extension)
 * @param {string} filePath
 * @returns {string}
 */
export function getStem(filePath) {
  return path.basename(filePath, path.extname(filePath));
}
