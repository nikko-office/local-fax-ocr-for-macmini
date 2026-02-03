"""
Local OCR API - FastAPI Entry Point

Single process, single worker, OCR engine initialized once at startup
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.responses import JSONResponse
import logging

from .config import settings
from .ocr_engine import OCREngine
from .preprocessor import ImagePreprocessor
from .schemas import FullTextAnnotation, HealthResponse

# Configure logging
logging.basicConfig(level=getattr(logging, settings.log_level))
logger = logging.getLogger(__name__)

# Global instances (singleton)
ocr_engine: OCREngine | None = None
preprocessor: ImagePreprocessor | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifecycle management
    Initialize OCR engine once at startup
    """
    global ocr_engine, preprocessor

    logger.info("Initializing OCR engine...")
    ocr_engine = OCREngine(
        lang=settings.ocr_lang,
        use_gpu=settings.ocr_use_gpu,
        enable_mkldnn=settings.ocr_enable_mkldnn,
        use_angle_cls=settings.ocr_use_angle_cls
    )
    preprocessor = ImagePreprocessor(
        scale_factor=settings.preprocess_scale_factor,
        binarize=settings.preprocess_binarize,
        binarize_threshold=settings.preprocess_binarize_threshold
    )
    logger.info("OCR engine initialized successfully")

    yield  # Application running

    # Cleanup
    logger.info("Shutting down OCR engine...")
    ocr_engine = None
    preprocessor = None


app = FastAPI(
    title="Local OCR API",
    description="PaddleOCR-based local OCR service for FAX documents",
    version="1.0.0",
    lifespan=lifespan
)


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint"""
    return HealthResponse(
        status="healthy",
        engine="paddleocr",
        lang=settings.ocr_lang,
        gpu_enabled=settings.ocr_use_gpu
    )


@app.post("/ocr", response_model=FullTextAnnotation)
async def perform_ocr(
    file: UploadFile = File(...),
    preprocess: bool = Query(default=True, description="Apply FAX preprocessing")
):
    """
    OCR execution endpoint

    Parameters:
    - file: Image file (PNG, JPG, TIFF, etc.)
    - preprocess: Apply FAX preprocessing (default: True)

    Returns:
    - FullTextAnnotation: Google Vision API compatible format
    """
    if ocr_engine is None:
        raise HTTPException(status_code=503, detail="OCR engine not initialized")

    # Read file
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    try:
        # Preprocessing
        if preprocess and preprocessor:
            image_data = preprocessor.process(content)
        else:
            image_data = content

        # Execute OCR
        result = ocr_engine.recognize(image_data)

        return result

    except Exception as e:
        logger.error(f"OCR failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
