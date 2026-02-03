#!/usr/bin/env python3
"""
Smart PDF rotation detection with OCR verification
Uses bounding box aspect ratios to determine correct orientation
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


def analyze_orientation(ocr_result):
    """
    OCR結果から向きの正しさをスコア化

    正しい向き:
    - 単語のbboxは横長（width > height）→ 横書きテキスト
    - 日本語文字が多い

    Returns:
        dict: score, japanese_count, word_count, avg_word_aspect
    """
    if not ocr_result:
        return {'score': 0, 'japanese_count': 0, 'word_count': 0, 'avg_word_aspect': 0}

    pages = ocr_result.get('pages', [])
    if not pages:
        return {'score': 0, 'japanese_count': 0, 'word_count': 0, 'avg_word_aspect': 0}

    # 単語のアスペクト比を集計
    word_aspects = []
    for page in pages:
        for block in page.get('blocks', []):
            for para in block.get('paragraphs', []):
                for word in para.get('words', []):
                    bbox = word.get('boundingBox', {})
                    vertices = bbox.get('vertices', [])
                    if len(vertices) == 4:
                        # vertices: [top-left, top-right, bottom-right, bottom-left]
                        width = vertices[1]['x'] - vertices[0]['x']
                        height = vertices[3]['y'] - vertices[0]['y']
                        if height > 0 and width > 0:
                            aspect = width / height
                            word_aspects.append(aspect)

    # 日本語文字数
    text = ocr_result.get('text', '')
    japanese_count = sum(1 for c in text if
        '\u3040' <= c <= '\u309F' or
        '\u30A0' <= c <= '\u30FF' or
        '\u4E00' <= c <= '\u9FFF')

    # 平均アスペクト比
    avg_aspect = sum(word_aspects) / len(word_aspects) if word_aspects else 0

    # スコア計算
    # - 横長の単語が多い（aspect > 1）→ 正しい向き（横書き）
    # - 縦長の単語が多い（aspect < 1）→ 90度ずれている
    horizontal_words = sum(1 for a in word_aspects if a > 1.0)
    vertical_words = sum(1 for a in word_aspects if a < 1.0)

    # スコア = 日本語文字数 × (横長単語の比率 + 0.5)
    if word_aspects:
        horizontal_ratio = horizontal_words / len(word_aspects)
    else:
        horizontal_ratio = 0.5

    score = japanese_count * (horizontal_ratio + 0.5)

    return {
        'score': round(score, 1),
        'japanese_count': japanese_count,
        'word_count': len(word_aspects),
        'avg_word_aspect': round(avg_aspect, 2),
        'horizontal_words': horizontal_words,
        'vertical_words': vertical_words
    }


def detect_rotation_with_ocr(pdf_path):
    """OCRを使って正しい回転角度を検出"""
    doc = fitz.open(pdf_path)
    page = doc[0]
    meta_rotation = page.rotation
    width = page.rect.width
    height = page.rect.height
    aspect = width / height
    doc.close()

    # メタデータに回転がある場合
    if meta_rotation != 0:
        rotation = (360 - meta_rotation) % 360
        return {
            'rotation': rotation,
            'needs_rotation': rotation != 0,
            'confidence': 'high',
            'method': 'metadata'
        }

    # 縦長の場合（正立の可能性が高い）
    if aspect < 0.8:
        return {
            'rotation': 0,
            'needs_rotation': False,
            'confidence': 'high',
            'method': 'aspect_ratio'
        }

    # 横長の場合、4方向すべてでOCRを試行
    if aspect > 1.2:
        print("Testing all orientations with OCR...", file=sys.stderr)

        results = {}
        for rot in [0, 90, 180, 270]:
            img = pdf_to_image(pdf_path, rotation=rot, dpi=150)
            ocr = ocr_request(img)
            analysis = analyze_orientation(ocr)
            results[rot] = analysis
            print(f"  {rot}°: score={analysis['score']:.0f}, jp={analysis['japanese_count']}, "
                  f"words={analysis['word_count']}, aspect={analysis['avg_word_aspect']}", file=sys.stderr)

        # 最高スコアの向きを選択
        best_rot = max(results.keys(), key=lambda r: results[r]['score'])
        best = results[best_rot]

        return {
            'rotation': best_rot,
            'needs_rotation': best_rot != 0,
            'confidence': 'medium',
            'method': 'ocr_analysis',
            'scores': {str(k): v['score'] for k, v in results.items()},
            'best_analysis': best
        }

    # それ以外
    return {
        'rotation': 0,
        'needs_rotation': False,
        'confidence': 'low',
        'method': 'default'
    }


def main():
    parser = argparse.ArgumentParser(description="Smart PDF rotation detection")
    parser.add_argument('--input-pdf', required=True, help="Input PDF file path")

    args = parser.parse_args()

    try:
        result = detect_rotation_with_ocr(args.input_pdf)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
