#!/usr/bin/env python3
"""
Searchable PDF Generator v5

OCR結果を使って既存PDFに不可視テキストレイヤーを追加。
行単位で独立したtext objectを配置し、自然なテキスト選択を実現。

重要ルール:
1. 各行ごとに独立した text object を作成
2. 行をまたいで text state を継続しない
3. フォントはサブセット埋め込み（1回定義）
4. 不可視テキスト（render_mode=3）
5. 視覚的描画は一切禁止

成功条件:
- テキスト選択時に行単位の自然な矩形
- ページ全体や列全体が選択されない
- 視覚的に元PDFと同一
- ファイルサイズが小さい

Usage:
    python searchable_pdf.py --input-pdf <pdf> --ocr-json <json> --output-pdf <out>
"""

import argparse
import json
import sys
from pathlib import Path
from collections import defaultdict

try:
    import fitz  # PyMuPDF
except ImportError:
    print("Error: PyMuPDF is required. Install with: pip install PyMuPDF", file=sys.stderr)
    sys.exit(1)


class SearchablePdfError(Exception):
    pass


def find_japanese_font():
    """日本語フォントを自動検出"""
    candidates = [
        ("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", "HiraginoKakuGothic"),
        ("/Library/Fonts/NotoSansCJKjp-Regular.otf", "NotoSansCJK"),
        ("/Library/Fonts/ipaexg.ttf", "IPAexGothic"),
        ("/System/Library/Fonts/Supplemental/AppleGothic.ttf", "AppleGothic"),
    ]
    for font_path, fontname in candidates:
        if Path(font_path).exists():
            return font_path, fontname
    return None, "helv"


def load_ocr_document(json_path):
    with open(json_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def transform_bbox_for_rotation(bbox, page_width, page_height, rotation):
    x0, y0, x1, y1 = bbox['x0'], bbox['y0'], bbox['x1'], bbox['y1']
    if rotation == 0:
        return bbox
    elif rotation == 90:
        return {'x0': page_height - y1, 'y0': x0, 'x1': page_height - y0, 'y1': x1}
    elif rotation == 180:
        return {'x0': page_width - x1, 'y0': page_height - y1, 'x1': page_width - x0, 'y1': page_height - y0}
    elif rotation == 270:
        return {'x0': y0, 'y0': page_width - x1, 'x1': y1, 'y1': page_width - x0}
    return bbox


def cluster_tokens_into_lines(tokens, y_tolerance=15):
    """トークンを行単位にクラスタリング"""
    if not tokens:
        return []

    lines_dict = defaultdict(list)
    for token in tokens:
        bbox = token.get('bbox', {})
        if not bbox:
            continue
        y_center = (bbox.get('y0', 0) + bbox.get('y1', 0)) / 2
        y_key = round(y_center / y_tolerance) * y_tolerance
        lines_dict[y_key].append(token)

    lines = []
    for y_key in sorted(lines_dict.keys()):
        line_tokens = sorted(lines_dict[y_key], key=lambda t: t.get('bbox', {}).get('x0', 0))

        y0_min = min(t['bbox'].get('y0', 0) for t in line_tokens if t.get('bbox'))
        y1_max = max(t['bbox'].get('y1', 0) for t in line_tokens if t.get('bbox'))
        x0_min = min(t['bbox'].get('x0', 0) for t in line_tokens if t.get('bbox'))

        lines.append({
            'tokens': line_tokens,
            'line_height': y1_max - y0_min,
            'x0': x0_min,
            'y0': y0_min,
            'y1': y1_max
        })

    return lines


def create_searchable_pdf(input_file, ocr_doc, output_pdf):
    """行単位で独立したtext objectを持つSearchable PDFを生成"""

    summary = {
        'total_pages': 0,
        'success_pages': 0,
        'total_chars': 0,
        'total_lines': 0,
        'japanese_chars': 0,
        'failures': []
    }

    font_path, fontname = find_japanese_font()

    try:
        input_path = Path(input_file)
        # PNG/JPEG入力の場合、まずPDFに変換
        if input_path.suffix.lower() in ['.png', '.jpg', '.jpeg', '.tiff', '.tif']:
            # 画像ファイルを直接読み込んでストリームとして埋め込む
            with open(input_file, 'rb') as f:
                img_data = f.read()

            # 画像サイズを取得
            pix = fitz.Pixmap(input_file)
            img_width, img_height = pix.width, pix.height
            pix = None

            # 新規PDFを作成（A4に近いサイズで）
            doc = fitz.open()
            # FAX画像は通常200dpi、ページサイズを計算
            page_width = img_width * 72 / 200
            page_height = img_height * 72 / 200
            pdf_page = doc.new_page(width=page_width, height=page_height)

            # 画像をストリームとして挿入（元の圧縮を維持）
            pdf_page.insert_image(
                pdf_page.rect,
                stream=img_data,
            )
        else:
            doc = fitz.open(input_file)
    except Exception as e:
        raise SearchablePdfError(f"Failed to open file: {e}")

    summary['total_pages'] = len(doc)
    pages = ocr_doc.get('pages', [])
    page_errors = []

    for page_idx, ocr_page in enumerate(pages):
        if page_idx >= len(doc):
            break

        try:
            page = doc[page_idx]
            page_rect = page.rect
            rotation = page.rotation

            ocr_width = ocr_page.get('width', 1)
            ocr_height = ocr_page.get('height', 1)

            if rotation in [90, 270]:
                scale_x = page_rect.width / ocr_height
                scale_y = page_rect.height / ocr_width
            else:
                scale_x = page_rect.width / ocr_width
                scale_y = page_rect.height / ocr_height

            # 全トークンを収集
            all_tokens = []
            for block in ocr_page.get('blocks', []):
                for line in block.get('lines', []):
                    tokens = line.get('tokens', [])
                    if tokens:
                        all_tokens.extend(tokens)
                    elif line.get('text', '').strip() and line.get('bbox'):
                        all_tokens.append({
                            'text': line.get('text', ''),
                            'bbox': line.get('bbox', {})
                        })

            # 行クラスタリング
            lines = cluster_tokens_into_lines(all_tokens)

            for line_info in lines:
                tokens = line_info['tokens']
                if not tokens:
                    continue

                # 行のフォントサイズを統一
                line_height_pdf = line_info['line_height'] * scale_y
                font_size = max(4, min(line_height_pdf * 0.75, 36))

                # 行内のテキストを結合
                line_text_parts = []
                prev_x1 = None

                for token in tokens:
                    text = token.get('text', '')
                    if not text.strip():
                        continue

                    bbox = token.get('bbox', {})
                    if rotation != 0:
                        bbox = transform_bbox_for_rotation(bbox, ocr_width, ocr_height, rotation)

                    x0 = bbox.get('x0', 0) * scale_x

                    # トークン間のギャップ
                    if prev_x1 is not None:
                        gap = x0 - prev_x1
                        if gap > font_size * 0.5:
                            num_spaces = max(1, int(gap / (font_size * 0.4)))
                            line_text_parts.append(' ' * num_spaces)

                    line_text_parts.append(text)
                    prev_x1 = bbox.get('x1', 0) * scale_x

                    # 日本語カウント
                    for char in text:
                        if '\u3040' <= char <= '\u309F' or \
                           '\u30A0' <= char <= '\u30FF' or \
                           '\u4E00' <= char <= '\u9FAF' or \
                           '\uFF00' <= char <= '\uFFEF':
                            summary['japanese_chars'] += 1

                line_text = ''.join(line_text_parts)
                if not line_text.strip():
                    continue

                # 行の開始位置
                first_bbox = tokens[0].get('bbox', {})
                if rotation != 0:
                    first_bbox = transform_bbox_for_rotation(first_bbox, ocr_width, ocr_height, rotation)

                start_x = first_bbox.get('x0', 0) * scale_x
                start_y = line_info['y1'] * scale_y

                # 各行ごとに独立したinsert_text呼び出し
                # これにより各行が独立したtext objectになる
                try:
                    page.insert_text(
                        fitz.Point(start_x, start_y),
                        line_text,
                        fontsize=font_size,
                        fontname=fontname,
                        fontfile=font_path,
                        render_mode=3,  # 不可視
                    )
                    summary['total_chars'] += len(line_text)
                    summary['total_lines'] += 1
                except Exception:
                    pass

            summary['success_pages'] += 1

        except Exception as e:
            error_info = {'page': page_idx, 'reason': 'processing', 'detail': str(e)}
            page_errors.append(error_info)
            summary['failures'].append(error_info)

    if page_errors:
        doc.close()
        raise SearchablePdfError(
            f"Failed: " + ", ".join(f"Page {e['page']}: {e['detail']}" for e in page_errors[:3])
        )

    try:
        # garbage=4でフォントサブセット化、deflateで圧縮
        doc.save(output_pdf, garbage=4, deflate=True)
    except Exception as e:
        doc.close()
        raise SearchablePdfError(f"Failed to save PDF: {e}")

    doc.close()
    return summary


def main():
    parser = argparse.ArgumentParser(description='Searchable PDF Generator (line-based text objects)')
    parser.add_argument('--input-pdf', required=True, help='Input PDF')
    parser.add_argument('--ocr-json', required=True, help='OCR JSON')
    parser.add_argument('--output-pdf', required=True, help='Output PDF')

    args = parser.parse_args()

    if not Path(args.input_pdf).exists():
        print(f"Error: Input PDF not found: {args.input_pdf}", file=sys.stderr)
        sys.exit(1)

    if not Path(args.ocr_json).exists():
        print(f"Error: OCR JSON not found: {args.ocr_json}", file=sys.stderr)
        sys.exit(1)

    try:
        ocr_doc = load_ocr_document(args.ocr_json)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        summary = create_searchable_pdf(args.input_pdf, ocr_doc, args.output_pdf)
        print(f"Created: {args.output_pdf}")
        print(f"  Pages: {summary['success_pages']}/{summary['total_pages']}")
        print(f"  Lines: {summary['total_lines']}")
        print(f"  Chars: {summary['total_chars']}")
        print(f"  Japanese: {summary['japanese_chars']}")
    except SearchablePdfError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
