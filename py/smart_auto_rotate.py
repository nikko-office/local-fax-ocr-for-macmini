#!/usr/bin/env python3
"""
Smart PDF rotation detection - Fast version
3段階判定で高速化
"""

import argparse
import json
import sys
import fitz
import requests
from pathlib import Path
import io
from PIL import Image


def pdf_to_image(pdf_path, rotation=0, dpi=150):
    """PDFを指定角度で回転させた画像に変換"""
    doc = fitz.open(pdf_path)
    page = doc[0]

    mat = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=mat)
    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)

    if rotation == 90:
        img = img.rotate(-90, expand=True)
    elif rotation == 180:
        img = img.rotate(-180, expand=True)
    elif rotation == 270:
        img = img.rotate(-270, expand=True)

    buf = io.BytesIO()
    img.save(buf, format='PNG')
    doc.close()
    return buf.getvalue()


def ocr_request(image_data):
    """OCR APIにリクエスト"""
    try:
        url = "http://localhost:8765/ocr?preprocess=false"
        files = {'file': ('image.png', image_data, 'image/png')}
        response = requests.post(url, files=files, timeout=30)
        if response.status_code == 200:
            return response.json()
        return None
    except Exception as e:
        print(f"OCR request failed: {e}", file=sys.stderr)
        return None


def calculate_score(ocr_result):
    """
    OCR結果からスコア計算
    スコア = 日本語文字数 × (横書き単語比率 + 0.5)
    """
    if not ocr_result:
        return 0, {}

    pages = ocr_result.get('pages', [])

    # 単語のアスペクト比を集計
    word_aspects = []
    for page in pages:
        for block in page.get('blocks', []):
            for para in block.get('paragraphs', []):
                for word in para.get('words', []):
                    bbox = word.get('boundingBox', {})
                    vertices = bbox.get('vertices', [])
                    if len(vertices) == 4:
                        width = vertices[1]['x'] - vertices[0]['x']
                        height = vertices[3]['y'] - vertices[0]['y']
                        if height > 0 and width > 0:
                            word_aspects.append(width / height)

    # 日本語文字数
    text = ocr_result.get('text', '')
    japanese_count = sum(1 for c in text if
        '\u3040' <= c <= '\u309F' or
        '\u30A0' <= c <= '\u30FF' or
        '\u4E00' <= c <= '\u9FFF')

    # 横書き単語の比率
    if word_aspects:
        horizontal_words = sum(1 for a in word_aspects if a > 1.0)
        horizontal_ratio = horizontal_words / len(word_aspects)
        avg_aspect = sum(word_aspects) / len(word_aspects)
    else:
        horizontal_ratio = 0.5
        avg_aspect = 0

    score = japanese_count * (horizontal_ratio + 0.5)

    details = {
        'japanese_count': japanese_count,
        'word_count': len(word_aspects),
        'avg_aspect': round(avg_aspect, 2),
        'horizontal_ratio': round(horizontal_ratio, 2)
    }

    return score, details


def detect_90_or_270(pdf_path, verbose=False):
    """
    90度と270度だけOCR比較（高速版）
    """
    scores = {}
    details = {}

    for rotation in [90, 270]:
        img = pdf_to_image(pdf_path, rotation=rotation, dpi=150)
        ocr = ocr_request(img)
        score, det = calculate_score(ocr)
        scores[rotation] = score
        details[rotation] = det

        if verbose:
            print(f"  {rotation}°: score={score:.0f}, jp={det.get('japanese_count', 0)}, "
                  f"aspect={det.get('avg_aspect', 0)}", file=sys.stderr)

    best = max(scores, key=scores.get)
    return best, scores, details


def detect_rotation_fast(pdf_path, verbose=False):
    """
    高速回転判定（3段階）

    Returns:
        dict: {
            'rotation': int,
            'needs_rotation': bool,
            'method': str,
            'details': dict
        }
    """
    doc = fitz.open(pdf_path)
    page = doc[0]

    # ========================================
    # STEP 1: メタデータチェック（0.1秒）
    # ========================================
    meta_rotation = page.rotation
    if meta_rotation != 0:
        rotation = (360 - meta_rotation) % 360
        doc.close()
        if verbose:
            print(f"STEP 1: Meta rotation detected: {meta_rotation}° → correct by {rotation}°", file=sys.stderr)
        return {
            'rotation': rotation,
            'needs_rotation': rotation != 0,
            'method': 'metadata',
            'details': {'meta_rotation': meta_rotation}
        }

    # ========================================
    # STEP 2: アスペクト比チェック（0.1秒）
    # ========================================
    width = page.rect.width
    height = page.rect.height
    aspect = width / height
    doc.close()

    # 明らかに縦長 → 正立
    if aspect < 0.8:
        if verbose:
            print(f"STEP 2: Portrait (aspect={aspect:.2f}) → no rotation", file=sys.stderr)
        return {
            'rotation': 0,
            'needs_rotation': False,
            'method': 'aspect_portrait',
            'details': {'aspect': round(aspect, 2)}
        }

    # 正方形に近い → 正立
    if 0.9 < aspect < 1.1:
        if verbose:
            print(f"STEP 2: Square (aspect={aspect:.2f}) → no rotation", file=sys.stderr)
        return {
            'rotation': 0,
            'needs_rotation': False,
            'method': 'aspect_square',
            'details': {'aspect': round(aspect, 2)}
        }

    # ========================================
    # STEP 3: 横長の場合のみOCR（2回、約10秒）
    # ========================================
    if aspect > 1.2:
        if verbose:
            print(f"STEP 3: Landscape (aspect={aspect:.2f}) → OCR comparison", file=sys.stderr)

        best, scores, details = detect_90_or_270(pdf_path, verbose)

        return {
            'rotation': best,
            'needs_rotation': True,
            'method': 'ocr_comparison',
            'details': {
                'aspect': round(aspect, 2),
                'scores': {str(k): round(v, 1) for k, v in scores.items()},
                'best_details': details[best]
            }
        }

    # デフォルト（0.8 <= aspect <= 1.2 の中間帯）
    if verbose:
        print(f"STEP 2: Moderate aspect ({aspect:.2f}) → no rotation", file=sys.stderr)
    return {
        'rotation': 0,
        'needs_rotation': False,
        'method': 'aspect_moderate',
        'details': {'aspect': round(aspect, 2)}
    }


def main():
    parser = argparse.ArgumentParser(description="Fast PDF rotation detection")
    parser.add_argument('--input-pdf', required=True, help="Input PDF file path")
    parser.add_argument('--verbose', '-v', action='store_true', help="Verbose output")

    args = parser.parse_args()

    try:
        result = detect_rotation_fast(args.input_pdf, verbose=args.verbose)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
