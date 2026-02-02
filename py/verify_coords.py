#!/usr/bin/env python3
"""
座標変換検証スクリプト

PDFを正立化し、OCR bboxとの座標一致を視覚的に確認する。
"""

import argparse
import json
import sys
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    print("Error: PyMuPDF required", file=sys.stderr)
    sys.exit(1)


def normalize_pdf(input_pdf, output_pdf):
    """PDFを正立化（Rotate=0）して保存"""
    doc = fitz.open(input_pdf)
    new_doc = fitz.open()

    for page_num in range(len(doc)):
        page = doc[page_num]
        rotation = page.rotation

        # 表示サイズを取得（回転適用後）
        if rotation in [90, 270]:
            display_width = page.rect.height
            display_height = page.rect.width
        else:
            display_width = page.rect.width
            display_height = page.rect.height

        # 正立化した新ページを作成
        new_page = new_doc.new_page(width=display_width, height=display_height)

        # 元ページの内容を正立化して挿入
        new_page.show_pdf_page(new_page.rect, doc, page_num)

        print(f"Page {page_num}: {page.rect.width}x{page.rect.height} Rotate={rotation}")
        print(f"  → Normalized: {display_width}x{display_height} Rotate=0")

    new_doc.save(output_pdf)
    new_doc.close()
    doc.close()

    # 検証：正立化されたか確認
    check_doc = fitz.open(output_pdf)
    check_page = check_doc[0]
    print(f"\nVerify: {output_pdf}")
    print(f"  MediaBox: {check_page.rect.width}x{check_page.rect.height}")
    print(f"  Rotation: {check_page.rotation}")
    check_doc.close()


def draw_marker_on_pdf(pdf_path, output_path, x, y, label=""):
    """PDFに座標マーカーを描画"""
    doc = fitz.open(pdf_path)
    page = doc[0]

    # 赤い円を描画
    shape = page.new_shape()
    shape.draw_circle(fitz.Point(x, y), 5)
    shape.finish(color=(1, 0, 0), fill=(1, 0, 0))
    shape.commit()

    # ラベルを追加
    if label:
        page.insert_text(fitz.Point(x + 10, y), label, fontsize=8, color=(1, 0, 0))

    doc.save(output_path)
    doc.close()
    print(f"Marker drawn at ({x:.1f}, {y:.1f}) on {output_path}")


def draw_marker_on_png(png_path, output_path, x, y, label=""):
    """PNGに座標マーカーを描画"""
    pix = fitz.Pixmap(png_path)

    # Pixmapを編集可能なPDFページに変換してマーカーを描画
    doc = fitz.open()
    page = doc.new_page(width=pix.width, height=pix.height)
    page.insert_image(page.rect, pixmap=pix)

    # 赤い円を描画
    shape = page.new_shape()
    shape.draw_circle(fitz.Point(x, y), 10)
    shape.finish(color=(1, 0, 0), fill=(1, 0, 0))
    shape.commit()

    if label:
        page.insert_text(fitz.Point(x + 15, y), label, fontsize=16, color=(1, 0, 0))

    # PNGとして保存
    out_pix = page.get_pixmap()
    out_pix.save(output_path)
    doc.close()
    print(f"Marker drawn at ({x:.1f}, {y:.1f}) on {output_path}")


def verify_bbox_alignment(pdf_path, png_path, ocr_json_path, output_dir):
    """OCR bboxの座標一致を検証"""

    # OCR JSONを読み込み
    with open(ocr_json_path, 'r', encoding='utf-8') as f:
        ocr_doc = json.load(f)

    pages = ocr_doc.get('pages', [])
    if not pages:
        print("No pages in OCR JSON")
        return

    ocr_page = pages[0]
    ocr_width = ocr_page.get('width', 1)
    ocr_height = ocr_page.get('height', 1)

    print(f"OCR dimensions: {ocr_width}x{ocr_height}")

    # 最初のテキストトークンを探す
    first_token = None
    for block in ocr_page.get('blocks', []):
        for line in block.get('lines', []):
            tokens = line.get('tokens', [])
            if tokens:
                first_token = tokens[0]
                break
        if first_token:
            break

    if not first_token:
        print("No tokens found")
        return

    bbox = first_token.get('bbox', {})
    text = first_token.get('text', '')

    # bbox中心点
    ocr_cx = (bbox.get('x0', 0) + bbox.get('x1', 0)) / 2
    ocr_cy = (bbox.get('y0', 0) + bbox.get('y1', 0)) / 2

    print(f"\nTarget token: '{text}'")
    print(f"  OCR bbox: x0={bbox.get('x0')}, y0={bbox.get('y0')}, x1={bbox.get('x1')}, y1={bbox.get('y1')}")
    print(f"  OCR center: ({ocr_cx:.1f}, {ocr_cy:.1f})")

    # PDFの情報を取得
    doc = fitz.open(pdf_path)
    page = doc[0]
    pdf_width = page.rect.width
    pdf_height = page.rect.height
    pdf_rotation = page.rotation
    doc.close()

    print(f"\nPDF: {pdf_width}x{pdf_height}, Rotation={pdf_rotation}")

    # PNGの情報を取得
    pix = fitz.Pixmap(png_path)
    png_width, png_height = pix.width, pix.height
    pix = None

    print(f"PNG: {png_width}x{png_height}")

    # スケール計算（OCR座標→PNG座標）
    png_scale_x = png_width / ocr_width
    png_scale_y = png_height / ocr_height

    png_x = ocr_cx * png_scale_x
    png_y = ocr_cy * png_scale_y

    print(f"\nPNG marker position: ({png_x:.1f}, {png_y:.1f})")

    # 正立化PDFの座標計算
    # 正立化後のPDFサイズは表示サイズと同じ
    if pdf_rotation in [90, 270]:
        norm_pdf_width = pdf_height
        norm_pdf_height = pdf_width
    else:
        norm_pdf_width = pdf_width
        norm_pdf_height = pdf_height

    pdf_scale_x = norm_pdf_width / ocr_width
    pdf_scale_y = norm_pdf_height / ocr_height

    pdf_x = ocr_cx * pdf_scale_x
    pdf_y = ocr_cy * pdf_scale_y

    print(f"Normalized PDF: {norm_pdf_width}x{norm_pdf_height}")
    print(f"PDF marker position: ({pdf_x:.1f}, {pdf_y:.1f})")

    # 出力
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. PDFを正立化
    norm_pdf_path = output_dir / "normalized.pdf"
    normalize_pdf(pdf_path, str(norm_pdf_path))

    # 2. 正立化PDFにマーカーを描画
    marked_pdf_path = output_dir / "marked_pdf.pdf"
    draw_marker_on_pdf(str(norm_pdf_path), str(marked_pdf_path), pdf_x, pdf_y, text)

    # 3. PNGにマーカーを描画
    marked_png_path = output_dir / "marked_png.png"
    draw_marker_on_png(png_path, str(marked_png_path), png_x, png_y, text)

    print(f"\n=== 検証ファイル生成完了 ===")
    print(f"1. {marked_pdf_path} - PDF上のマーカー位置")
    print(f"2. {marked_png_path} - PNG上のマーカー位置")
    print(f"\n両方を開いて、マーカーが同じテキスト位置にあることを確認してください。")


def main():
    parser = argparse.ArgumentParser(description='Coordinate verification')
    parser.add_argument('--pdf', required=True, help='Input PDF')
    parser.add_argument('--png', required=True, help='Input PNG (OCR source)')
    parser.add_argument('--ocr-json', required=True, help='OCR JSON')
    parser.add_argument('--output-dir', default='./verify_output', help='Output directory')

    args = parser.parse_args()

    verify_bbox_alignment(args.pdf, args.png, args.ocr_json, args.output_dir)


if __name__ == '__main__':
    main()
