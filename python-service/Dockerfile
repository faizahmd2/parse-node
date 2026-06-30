FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    poppler-utils \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Install torch separately first (largest package, specific index)
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu

# Install rest
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download models at build time
RUN python -c "import easyocr; easyocr.Reader(['en'], gpu=False)"
RUN python -c "from transformers import TrOCRProcessor, VisionEncoderDecoderModel; TrOCRProcessor.from_pretrained('microsoft/trocr-base-handwritten'); VisionEncoderDecoderModel.from_pretrained('microsoft/trocr-base-handwritten')"

COPY app/ ./app/

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]