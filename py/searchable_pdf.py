#!/usr/bin/env python3
"""
Searchable PDF Generator v5.3

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
from statistics import median

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






def _estimate_y_tolerance(tokens, default=15):
    """
    固定15pxはDPI/スケールで簡単に崩れる。
    トークン高さの中央値を基準に tolerence を決める。
    """
    hs = []
    for t in tokens:
        b = t.get("bbox") or {}
        y0 = b.get("y0")
        y1 = b.get("y1")
        if y0 is None or y1 is None:
            continue
        h = max(0, float(y1) - float(y0))
        if h > 0:
            hs.append(h)
    if not hs:
        return default
    mh = median(hs)
    # 行の中心が少しズレても同一行として束ねられる程度
    return max(6, min(int(mh * 0.8), 60))


def cluster_tokens_into_lines(tokens, y_tolerance=None):
    """トークンを行単位にクラスタリング"""
    if not tokens:
        return []
    if y_tolerance is None:
        y_tolerance = _estimate_y_tolerance(tokens)

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




def create_searchable_pdf(input_file, ocr_doc, output_pdf, dpi=300):
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

            # 新規PDFを作成（DPIに基づくページサイズ）
            src_doc = fitz.open()
            page_width = img_width * 72 / dpi
            page_height = img_height * 72 / dpi
            pdf_page = src_doc.new_page(width=page_width, height=page_height)

            # 画像をストリームとして挿入（元の圧縮を維持）
            pdf_page.insert_image(
                pdf_page.rect,
                stream=img_data,
            )
            doc = src_doc  # 画像入力は既に正立
        else:
            # 入力PDFは既にmain.jsで正規化済み（rotation=0）
            # そのまま使用する
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
            # 入力PDFは既に正規化済み（rotation=0）であることを期待
            # main.jsが事前にnormalize_pdf.pyで正規化している
            pdf_width = page.rect.width
            pdf_height = page.rect.height

            ocr_width = ocr_page.get('width', 1)
            ocr_height = ocr_page.get('height', 1)

            # 単純な比率でスケール計算
            # OCR座標（ピクセル）→ PDF座標（ポイント）への直接マッピング
            # PaddleOCRの前処理スケール（2x）も含めた実際の座標値を使用
            scale_x = pdf_width / ocr_width
            scale_y = pdf_height / ocr_height

            # 全トークンを収集（複数フォーマット対応）
            all_tokens = []
            for block in ocr_page.get('blocks', []):
                # フォーマット1: blocks/lines/tokens（正規化済み）
                for line in block.get('lines', []):
                    tokens = line.get('tokens', [])
                    if tokens:
                        all_tokens.extend(tokens)
                    elif line.get('text', '').strip() and line.get('bbox'):
                        all_tokens.append({
                            'text': line.get('text', ''),
                            'bbox': line.get('bbox', {})
                        })

                # フォーマット2: blocks/paragraphs/words（Google Vision形式）
                for para in block.get('paragraphs', []):
                    for word in para.get('words', []):
                        # symbolsからテキストを結合
                        text = ''.join(s.get('text', '') for s in word.get('symbols', []))
                        if not text.strip():
                            continue

                        # boundingBox.vertices から bbox を抽出
                        vertices = word.get('boundingBox', {}).get('vertices', [])
                        if len(vertices) >= 4:
                            xs = [v.get('x', 0) for v in vertices]
                            ys = [v.get('y', 0) for v in vertices]
                            bbox = {
                                'x0': min(xs),
                                'y0': min(ys),
                                'x1': max(xs),
                                'y1': max(ys)
                            }
                            all_tokens.append({'text': text, 'bbox': bbox})

            # 座標変換は不要（main.jsが事前にPDFを正規化しているため、
            # OCR座標とPDFは同じ座標系になっている）

            # 行クラスタリング
            lines = cluster_tokens_into_lines(all_tokens, y_tolerance=None)

            for line_info in lines:
                tokens = line_info['tokens']
                if not tokens:
                    continue

                # 行のフォントサイズを統一
                line_height_pdf = line_info['line_height'] * scale_y
                font_size = max(4, line_height_pdf * 0.75)

                # 行内のテキストを結合
                line_text_parts = []
                prev_x1 = None

                for token in tokens:
                    text = token.get('text', '')
                    if not text.strip():
                        continue

                    bbox = token.get('bbox', {})
                    x0 = bbox.get('x0', 0) * scale_x

                    # トークン間のギャップ
                    if prev_x1 is not None:
                        gap = x0 - prev_x1
                        if gap > font_size * 0.5:
                            # 日本語フォントの半角スペース幅は約0.25em、英語は約0.3-0.4em
                            space_width = font_size * 0.3
                            num_spaces = max(1, int(gap / space_width))
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

                # 行の開始位置（OCR座標→PDF座標、正立化済みなので単純スケール）
                first_bbox = tokens[0].get('bbox', {})
                pdf_x = first_bbox.get('x0', 0) * scale_x
                # PyMuPDFのinsert_text()はy座標をベースラインとして解釈する
                # 日本語フォントの場合、ベースラインは行高の約75%の位置
                pdf_y = (line_info['y0'] * scale_y) + (line_height_pdf * 0.75)

                # 座標範囲チェック
                if pdf_x < 0 or pdf_x > pdf_width or pdf_y < 0 or pdf_y > pdf_height:
                    summary['failures'].append({
                        'page': page_idx,
                        'reason': 'out_of_bounds',
                        'detail': f'Text position ({pdf_x:.1f}, {pdf_y:.1f}) outside page ({pdf_width:.1f} x {pdf_height:.1f})'
                    })
                    continue

                # 各行ごとに独立したinsert_text呼び出し
                # これにより各行が独立したtext objectになる
                try:
                    page.insert_text(
                        fitz.Point(pdf_x, pdf_y),
                        line_text,
                        fontsize=font_size,
                        fontname=fontname,
                        fontfile=font_path,
                        render_mode=3,  # 不可視
                        rotate=0,  # 横書き（明示的に指定）
                    )
                    summary['total_chars'] += len(line_text)
                    summary['total_lines'] += 1
                except Exception as e:
                    # サイレントに落とすと原因追えないので記録する
                    summary['failures'].append({
                        'page': page_idx,
                        'reason': 'insert_text',
                        'detail': str(e)[:200]
                    })

            summary['success_pages'] += 1

        except Exception as e:
            error_info = {'page': page_idx, 'reason': 'processing', 'detail': str(e)}
            page_errors.append(error_info)
            summary['failures'].append(error_info)

    # ページ処理自体が落ちたら失敗
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
    parser.add_argument('--dpi', type=int, default=300, help='OCR DPI (default: 300)')

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
        summary = create_searchable_pdf(args.input_pdf, ocr_doc, args.output_pdf, dpi=args.dpi)
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
