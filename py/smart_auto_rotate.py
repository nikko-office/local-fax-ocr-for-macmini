#!/usr/bin/env python3
"""
Smart PDF auto-rotation detection

方針（シンプル版）:
1. PDFメタデータの回転を確認
2. アスペクト比で横長かどうかを判定
3. OCRは使わない（高速・シンプル）
"""

import argparse
import json
import sys
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    print("Error: PyMuPDF is required", file=sys.stderr)
    sys.exit(1)


def detect_rotation(pdf_path):
    """
    PDFの必要な回転角度を自動検出

    Returns:
        dict: {
            'rotation': int (0, 90, 180, 270),
            'needs_rotation': bool,
            'reason': str,
            'details': dict
        }
    """
    doc = fitz.open(pdf_path)
    page = doc[0]

    rotation = page.rotation
    width = page.rect.width
    height = page.rect.height
    aspect = width / height

    details = {
        'meta_rotation': rotation,
        'width': round(width, 1),
        'height': round(height, 1),
        'aspect': round(aspect, 3),
        'orientation': 'landscape' if aspect > 1.0 else 'portrait'
    }

    doc.close()

    # CASE 1: メタデータに回転がある場合
    if rotation != 0:
        corrected = (360 - rotation) % 360
        return {
            'rotation': corrected,
            'needs_rotation': True,
            'reason': f'meta_rotation={rotation}',
            'details': details
        }

    # CASE 2: 横長の場合（FAX文書は縦が正位置）
    if aspect > 1.2:
        return {
            'rotation': 90,
            'needs_rotation': True,
            'reason': 'landscape_detected',
            'details': details
        }

    # CASE 3: 縦長または正方形に近い（正立している）
    return {
        'rotation': 0,
        'needs_rotation': False,
        'reason': 'already_portrait',
        'details': details
    }


def main():
    parser = argparse.ArgumentParser(description="Smart PDF rotation detection")
    parser.add_argument('--input-pdf', required=True, help="Input PDF file path")
    parser.add_argument('--verbose', '-v', action='store_true', help="Verbose output")

    args = parser.parse_args()

    if not Path(args.input_pdf).exists():
        print(json.dumps({'error': f'File not found: {args.input_pdf}'}), file=sys.stderr)
        return 1

    try:
        result = detect_rotation(args.input_pdf)

        if args.verbose:
            print(f"結果: {result['rotation']}° ({result['reason']})", file=sys.stderr)
            print(f"詳細: {result['details']}", file=sys.stderr)

        print(json.dumps(result))
        return 0

    except Exception as e:
        import traceback
        if args.verbose:
            traceback.print_exc()
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
