"""
Response schemas - Google Vision API fullTextAnnotation compatible
"""

from typing import Optional
from pydantic import BaseModel


class Vertex(BaseModel):
    """Vertex point"""
    x: int = 0
    y: int = 0


class BoundingBox(BaseModel):
    """Bounding box with vertices (Google Vision API format)"""
    vertices: list[Vertex]


class Symbol(BaseModel):
    """Character/symbol"""
    text: str
    confidence: float = 0.0


class Word(BaseModel):
    """Word (collection of symbols)"""
    boundingBox: Optional[BoundingBox] = None
    symbols: list[Symbol]
    confidence: float = 0.0


class Paragraph(BaseModel):
    """Paragraph (collection of words)"""
    boundingBox: Optional[BoundingBox] = None
    words: list[Word]


class Block(BaseModel):
    """Block (collection of paragraphs)"""
    boundingBox: Optional[BoundingBox] = None
    paragraphs: list[Paragraph]


class Page(BaseModel):
    """Page"""
    width: int
    height: int
    blocks: list[Block]


class FullTextAnnotation(BaseModel):
    """
    Google Vision API fullTextAnnotation compatible response

    This matches the structure expected by ocr_schema.js
    """
    text: str
    pages: list[Page]


class HealthResponse(BaseModel):
    """Health check response"""
    status: str
    engine: str
    lang: str
    gpu_enabled: bool
