import os
from fastapi import FastAPI
from pydantic import BaseModel
from markitdown import MarkItDown
from sentence_transformers import SentenceTransformer
from transformers import pipeline
from app.filters.hard_filter import hard_filter, extract_clean_text
from app.filters.semantic_filter import semantic_score
from app.filters.semantic_filter import DEFAULT_IMPORTANT_SEEDS
import fitz
import pytesseract
from pypdf import PdfReader
from pdf2image import convert_from_path
import cv2
from PIL import Image
import re

app = FastAPI()

# Load once at startup - this is why we keep this as a long-running service
md_converter = MarkItDown()
embed_model = SentenceTransformer('all-MiniLM-L6-v2')

DEFAULT_SEED_EMBEDDINGS = embed_model.encode(
    DEFAULT_IMPORTANT_SEEDS,

    normalize_embeddings=True
)

classifier = pipeline(
    "zero-shot-classification",

    model="valhalla/distilbart-mnli-12-1"
)

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif'}

# EasyOCR and TrOCR are both fairly heavy (extra PyTorch model loads), and only
# needed when someone actually uploads an image — so load them lazily on first
# use rather than eagerly at startup alongside the always-used models above.
_easyocr_reader = None
_trocr_processor = None
_trocr_model = None


def get_easyocr_reader():
    global _easyocr_reader
    if _easyocr_reader is None:
        import easyocr
        _easyocr_reader = easyocr.Reader(['en'], gpu=False)
    return _easyocr_reader


def get_trocr():
    """microsoft/trocr-base-handwritten: a line-level OCR model that's
    meaningfully better than Tesseract/EasyOCR on handwriting specifically.
    Operates on single cropped text lines, not full pages."""
    global _trocr_processor, _trocr_model
    if _trocr_model is None:
        from transformers import TrOCRProcessor, VisionEncoderDecoderModel
        _trocr_processor = TrOCRProcessor.from_pretrained('microsoft/trocr-base-handwritten')
        _trocr_model = VisionEncoderDecoderModel.from_pretrained('microsoft/trocr-base-handwritten')
    return _trocr_processor, _trocr_model

class ParseRequest(BaseModel):
    file_path: str

class ChunkRequest(BaseModel):
    text: str
    chunk_size: int = 800
    overlap: int = 100

class EmbedRequest(BaseModel):
    texts: list[str]

class PreprocessRequest(BaseModel):
    subject: str = ''
    body: str = ''
    from_address: str = ''
    client_seeds: list[str] = []  # optional client-specific important phrases


class ClassifyRequest(BaseModel):
    text: str
    categories: list[str]
    urgency_levels: list[str]

def parse_pdf(path):

    # Stage 1
    try:

        doc = fitz.open(path)

        text = []

        for page in doc:

            page_text = page.get_text()

            if page_text:
                text.append(page_text)

        output = "\n".join(text)

        if len(output.strip()) > 100:
            return output

    except Exception as e:

        print("pymupdf", e)

    # Stage 2

    try:

        reader = PdfReader(path)

        text = []

        for page in reader.pages:

            page_text = page.extract_text()

            if page_text:
                text.append(page_text)

        output = "\n".join(text)

        if len(output.strip()) > 100:
            return output

    except Exception as e:

        print("pypdf", e)

    # Stage 3 OCR

    try:

        images = convert_from_path(path)

        text = []

        for image in images:

            text.append(
                pytesseract.image_to_string(image)
            )

        return "\n".join(text)

    except Exception as e:

        print("ocr", e)

    return ""


def preprocess_image_for_ocr(path):
    """Grayscale + upscale small images + adaptive threshold. This alone
    recovers a lot of Tesseract's accuracy loss on photos vs clean scans."""
    img = cv2.imread(path)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    h, w = gray.shape
    if max(h, w) < 1500:
        scale = 1500 / max(h, w)
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    return cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 11
    )


def _ocr_score(text: str) -> int:
    """Heuristic for 'how much usable text did we recover' — used to pick the
    best result among multiple OCR backends when there's no ground truth."""
    return len(re.sub(r'[^A-Za-z0-9]', '', text or ''))


def ocr_trocr_lines(path, max_lines=80):
    """Line-level handwriting OCR: detect text line boxes with EasyOCR's
    detector, then run each crop through TrOCR's handwriting-tuned model.
    Slower than Tesseract/EasyOCR (one forward pass per line on CPU), so this
    is only used as an escalation when the faster engines come back thin."""
    reader = get_easyocr_reader()
    horizontal_list, _ = reader.detect(path)

    if not horizontal_list or not horizontal_list[0]:
        return ""

    boxes = horizontal_list[0][:max_lines]
    # reading order: top-to-bottom, then left-to-right
    boxes = sorted(boxes, key=lambda b: (b[2], b[0]))

    image = Image.open(path).convert("RGB")
    processor, model = get_trocr()

    lines = []
    for x_min, x_max, y_min, y_max in boxes:
        crop = image.crop((max(0, x_min), max(0, y_min), x_max, y_max))
        if crop.width < 4 or crop.height < 4:
            continue
        pixel_values = processor(images=crop, return_tensors="pt").pixel_values
        generated_ids = model.generate(pixel_values, max_new_tokens=64)
        lines.append(processor.batch_decode(generated_ids, skip_special_tokens=True)[0])

    return "\n".join(lines)


def parse_image(path):
    """Tries Tesseract and EasyOCR (both handle printed text well), keeps
    whichever recovered more text, then escalates to TrOCR handwriting
    recognition only if both came back thin — that's the expensive path."""
    candidates = []

    try:
        processed = preprocess_image_for_ocr(path)
        candidates.append(pytesseract.image_to_string(processed, config='--oem 3 --psm 6'))
    except Exception as e:
        print("tesseract ocr", e)

    try:
        reader = get_easyocr_reader()
        candidates.append("\n".join(reader.readtext(path, detail=0)))
    except Exception as e:
        print("easyocr", e)

    best = max(candidates, key=_ocr_score, default="")

    if _ocr_score(best) < 20:
        try:
            trocr_text = ocr_trocr_lines(path)
            if _ocr_score(trocr_text) > _ocr_score(best):
                best = trocr_text
        except Exception as e:
            print("trocr", e)
    # return best
    return clean_ocr_artifacts(best)


def split_by_headers(text: str):
    """Split markdown into sections based on headers, keeping header with content."""
    # Match lines starting with # (markdown headers)
    pattern = r'(?=^#{1,6}\s)'
    sections = re.split(pattern, text, flags=re.MULTILINE)
    return [s.strip() for s in sections if s.strip()]


def recursive_split(text: str, chunk_size: int, overlap: int):
    """Fallback splitter: paragraphs -> sentences -> hard cut."""
    if len(text) <= chunk_size:
        return [text]

    # Try splitting by paragraphs first
    paragraphs = text.split('\n\n')
    if len(paragraphs) > 1:
        return _merge_pieces(paragraphs, chunk_size, overlap, joiner='\n\n')

    # Try splitting by sentences
    sentences = re.split(r'(?<=[.!?])\s+', text)
    if len(sentences) > 1:
        return _merge_pieces(sentences, chunk_size, overlap, joiner=' ')

    # Last resort: hard cut with overlap
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start = end - overlap
    return chunks


def _merge_pieces(pieces, chunk_size, overlap, joiner):
    chunks = []
    current = ""
    for piece in pieces:
        piece = piece.strip()
        if not piece:
            continue
        if len(current) + len(piece) + len(joiner) <= chunk_size:
            current = current + joiner + piece if current else piece
        else:
            if current:
                chunks.append(current)
            # If a single piece is itself too large, recurse
            if len(piece) > chunk_size:
                chunks.extend(recursive_split(piece, chunk_size, overlap))
                current = ""
            else:
                current = piece
    if current:
        chunks.append(current)

    # Add overlap between consecutive chunks
    if overlap > 0 and len(chunks) > 1:
        overlapped = [chunks[0]]
        for i in range(1, len(chunks)):
            prev_tail = chunks[i-1][-overlap:]
            overlapped.append(prev_tail + joiner + chunks[i])
        return overlapped

    return chunks

def clean_ocr_artifacts(raw_text: str) -> str:
    """Removes common structural OCR artifacts (borders, creases, dashed lines)."""
    lines = raw_text.split('\n')
    cleaned_lines = []
    
    for line in lines:
        # 1. Strip leading and trailing noise characters (borders, creases)
        line = re.sub(r'^[\s\|\~\—\}\-\.]+|[\s\|\~\—\}\-\.]+$', '', line)
        
        # 2. Remove standalone rogue characters from the middle of the text
        line = line.replace('|', '').replace('}', '').replace('~', '')
        
        # 3. Normalize whitespace (squeeze double spaces into one)
        line = re.sub(r'\s{2,}', ' ', line)
        
        # 4. Only keep lines that contain at least one letter or number
        # This prevents lines that are just pure noise from making it through
        if re.search(r'[A-Za-z0-9]', line):
            cleaned_lines.append(line.strip())
            
    return '\n'.join(cleaned_lines)

@app.post("/parse")
def parse_file(req: ParseRequest):

    if not os.path.exists(req.file_path):

        return {
            "error":"File not found"
        }

    ext = os.path.splitext(req.file_path)[1].lower()

    if ext == ".pdf":

        text = parse_pdf(req.file_path)

    elif ext in IMAGE_EXTS:

        text = parse_image(req.file_path)

    else:

        result = md_converter.convert(req.file_path)

        text = result.text_content

    if not text:

        return {
            "error":"Could not parse file"
        }

    return {
        "markdown": text
    }


@app.post("/chunk")
def chunk_text(req: ChunkRequest):
    sections = split_by_headers(req.text)

    all_chunks = []
    for section in sections:
        all_chunks.extend(recursive_split(section, req.chunk_size, req.overlap))

    return {"chunks": all_chunks, "count": len(all_chunks)}

@app.post("/embed")
def embed_texts(req: EmbedRequest):
    embeddings = embed_model.encode(
        req.texts,

        batch_size=32,

        normalize_embeddings=True,

        convert_to_numpy=True
    )
    return {"embeddings": embeddings.tolist()}

@app.post("/preprocess")
def preprocess_email(req: PreprocessRequest):
    """
    Stage 1 + 2 + 3: Hard filter → clean → semantic score.
    Returns whether email should proceed to classification.
    """
    # Stage 1: Hard filter
    filter_result = hard_filter(req.subject, req.body, req.from_address)
    if not filter_result["passed"]:
        return {
            "proceed": False,
            "stage": "hard_filter",
            "reason": filter_result["reason"],
            "text": None
        }

    # Stage 2: Extract clean text
    extraction = extract_clean_text(req.subject, req.body)
    if extraction["quality"] != "good":
        return {
            "proceed": False,
            "stage": "content_extraction",
            "reason": extraction["quality"],
            "text": None
        }

    # Stage 3: Semantic pre-filter
    semantic = semantic_score(
        extraction["text"],
        embed_model,
        DEFAULT_SEED_EMBEDDINGS,
        req.client_seeds
    )

    if not semantic["passed"]:
        return {
            "proceed": False,
            "stage": "semantic_filter",
            "reason": f"low_similarity:{semantic['score']}",
            "best_match": semantic["best_match"],
            "score": semantic["score"],
            "text": extraction["text"]
        }

    return {
        "proceed": True,
        "stage": "passed_all",
        "score": semantic["score"],
        "best_match": semantic["best_match"],
        "text": extraction["text"],  # clean text ready for classification
    }

# Messages classification
@app.post("/classify")
def classify_text(req: ClassifyRequest):
    text = req.text[:2000]

    category_result = classifier(
        text,
        req.categories
    )

    urgency_result = classifier(
        text,
        req.urgency_levels
    )

    return {
        "category": category_result["labels"][0],
        "category_confidence": round(category_result["scores"][0], 4),
        "urgency": urgency_result["labels"][0],
        "urgency_confidence": round(urgency_result["scores"][0], 4),
    }


@app.get("/health")
def health():
    return {"status": "ok"}