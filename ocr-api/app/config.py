"""
Configuration management - Load settings from environment variables
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings"""

    # OCR settings
    ocr_lang: str = "japan"
    ocr_use_gpu: bool = False
    ocr_enable_mkldnn: bool = False

    # Preprocessing settings
    preprocess_scale_factor: float = 2.0
    preprocess_binarize: bool = True
    preprocess_binarize_threshold: int = 0  # 0 = Otsu auto

    # Logging
    log_level: str = "INFO"

    class Config:
        env_prefix = ""


settings = Settings()
