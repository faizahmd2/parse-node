import os
from fastapi import FastAPI
from pydantic import BaseModel
from markitdown import MarkItDown
import fitz
import pytesseract
from pytesseract import Output
from pypdf import PdfReader
from pdf2image import convert_from_path
import cv2
from PIL import Image
import re
import torch

cv2.setNumThreads(2)
torch.set_num_threads(2)

app = FastAPI()

# Load once at startup - this is why we keep this as a long-running service
md_converter = MarkItDown()

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

class FormatRequest(BaseModel):
    text: str
    filename: str = ''

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
    """Normalize every image to a consistent character size before OCR.

    Verified empirically on a real phone-photo receipt: confidence DROPPED
    from ~76 at ~1000px down to ~51 at the original 2710px on the same
    image — modern phone cameras shoot at resolutions where character
    height ends up much larger than what Tesseract was trained on, and that
    measurably hurts recognition. Small/low-res images get upscaled for the
    same reason in reverse. ~1100px on the long edge was the sweet spot
    across the range tested (700-2710px); resize (not denoise) is what's
    doing the real work here.

    Denoising was tried and intentionally removed: fastNlMeansDenoising
    blurred this receipt's thin dot-matrix character strokes enough to
    actively corrupt words ("FLAVOURED MOJITO" became "Ftp Ayerees BOJITO").
    It only pays off on genuinely grainy/low-light photos — if you run into
    one of those, reintroduce it conditionally rather than unconditionally.
    """
    img = cv2.imread(path)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    h, w = gray.shape
    target = 1100
    scale = target / max(h, w)
    interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=interp)

    adaptive = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 11
    )
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    return adaptive, otsu


def _quality_score(mean_conf: float, text: str) -> float:
    """Texts under 15 chars are treated as a failed read regardless of
    confidence — a couple of high-confidence words isn't a usable result."""
    if len(text.strip()) < 15:
        return 0.0
    return mean_conf


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

def _group_words_by_line(data):
    """Groups image_to_data's flat word list into per-line word lists with
    position info, ordered top-to-bottom then left-to-right within each
    line. Shared by both renderers below so OCR only ever runs once."""
    lines = {}
    for i in range(len(data['text'])):
        word = data['text'][i].strip()
        if not word:
            continue
        key = (data['block_num'][i], data['par_num'][i], data['line_num'][i])
        lines.setdefault(key, []).append({
            'text': word,
            'left': data['left'][i],
            'top': data['top'][i],
            'width': data['width'][i],
            'height': data['height'][i],
        })
    ordered_keys = sorted(lines.keys(), key=lambda k: min(w['top'] for w in lines[k]))
    return [sorted(lines[k], key=lambda w: w['left']) for k in ordered_keys]
 
 
def _flat_text(line_groups) -> str:
    """Single-spaced text for embeddings/chunking — equivalent to what
    image_to_string would give, but derived from the already-computed
    image_to_data groups instead of a second OCR pass."""
    return '\n'.join(' '.join(w['text'] for w in line) for line in line_groups)
 
 
def _layout_text(line_groups) -> str:
    """Spacing-preserved text for display: converts each word's pixel
    X-position into a character-column position so horizontal gaps in the
    output mirror horizontal gaps in the source image. Also preserves
    vertical whitespace — an unusually large gap between consecutive lines'
    Y-positions becomes a blank line, matching section breaks in the image.
    Every word is copied verbatim; only whitespace is inserted."""
    if not line_groups:
        return ''
 
    ratios = sorted(
        w['width'] / len(w['text']) for line in line_groups for w in line
    )
    char_px = ratios[len(ratios) // 2] if ratios else 10.0
 
    heights = [max(w['height'] for w in line) for line in line_groups]
    median_height = sorted(heights)[len(heights) // 2] if heights else 20
    tops = [min(w['top'] for w in line) for line in line_groups]
 
    out = []
    for idx, line in enumerate(line_groups):
        if idx > 0 and (tops[idx] - tops[idx - 1]) > median_height * 1.8:
            out.append('')
        rendered, cursor = '', 0
        for w in line:
            col = max(cursor, round(w['left'] / char_px))
            rendered += ' ' * (col - cursor) + w['text']
            cursor = col + len(w['text'])
        out.append(rendered.rstrip())
 
    return '\n'.join(out)
 
 
def tesseract_ocr(image, config='--oem 3 --psm 6'):
    """One OCR pass per image variant. Returns (flat_text, layout_text,
    mean_confidence). Previously this called image_to_string AND
    image_to_data separately — two Tesseract subprocess invocations on the
    same pixels. Deriving flat_text from image_to_data's own word list
    removes that duplicate call entirely."""
    data = pytesseract.image_to_data(image, config=config, output_type=Output.DICT)
    line_groups = _group_words_by_line(data)
 
    confidences = [int(c) for c in data['conf'] if c != '' and int(c) >= 0]
    mean_conf = sum(confidences) / len(confidences) if confidences else 0.0
 
    return _flat_text(line_groups), _layout_text(line_groups), mean_conf
 
 
def _quality_score(mean_conf: float, text: str) -> float:
    if len(text.strip()) < 15:
        return 0.0
    return mean_conf
 
 
def parse_image(path):
    """Returns (flat_text, layout_text). layout_text may be '' if the
    winning result came from the EasyOCR/TrOCR escalation paths, which
    don't expose per-word pixel positions the same way Tesseract does —
    known gap, only affects the rarer low-confidence escalation cases."""
    adaptive, otsu = preprocess_image_for_ocr(path)
 
    best_score, best_flat, best_layout = 0.0, "", ""
    for variant in (adaptive, otsu):
        try:
            flat, layout, mean_conf = tesseract_ocr(variant)
            score = _quality_score(mean_conf, flat)
            if score > best_score:
                best_score, best_flat, best_layout = score, flat, layout
        except Exception as e:
            print("tesseract ocr", e)
 
    EASYOCR_ESCALATION_THRESHOLD = 40
    if best_score < EASYOCR_ESCALATION_THRESHOLD:
        try:
            reader = get_easyocr_reader()
            results = reader.readtext(path, detail=1)
            words = [(text, conf * 100) for (_, text, conf) in results if conf >= 0.3]
            if words:
                easy_text = "\n".join(t for t, _ in words)
                easy_conf = sum(c for _, c in words) / len(words)
                easy_score = _quality_score(easy_conf, easy_text)
                if easy_score > best_score:
                    best_score, best_flat, best_layout = easy_score, easy_text, ""
        except Exception as e:
            print("easyocr", e)
 
    TROCR_ESCALATION_THRESHOLD = 25
    if best_score < TROCR_ESCALATION_THRESHOLD:
        try:
            trocr_text = ocr_trocr_lines(path)
            if len(trocr_text.strip()) >= 15:
                best_flat, best_layout = trocr_text, ""
        except Exception as e:
            print("trocr", e)
 
    # clean_ocr_artifacts strips leading whitespace per line — fine for
    # best_flat, but it would destroy best_layout's column alignment, so it
    # only ever runs on the flat text.
    cleaned_flat = clean_ocr_artifacts(best_flat)
    return cleaned_flat, best_layout
 
 
@app.post("/parse")
def parse_file(req: ParseRequest):
 
    if not os.path.exists(req.file_path):
        return {"error": "File not found"}
 
    ext = os.path.splitext(req.file_path)[1].lower()
    layout_text = None
 
    if ext == ".pdf":
        text = parse_pdf(req.file_path)
 
    elif ext in IMAGE_EXTS:
        text, layout_text = parse_image(req.file_path)
 
    else:
        result = md_converter.convert(req.file_path)
        text = result.text_content
 
    if not text:
        return {"error": "Could not parse file"}
 
    response = {"markdown": text}
    if layout_text and layout_text.strip():
        # Fenced code block: standard Markdown collapses repeated spaces
        # outside one, which would silently destroy the alignment.
        response["layout_markdown"] = "```\n" + layout_text + "\n```"
 
    return response

@app.get("/health")
def health():
    return {"status": "ok"}


def format_markdown_local(text: str) -> str:
    """Minimal whitespace cleanup only — no structural guessing.

    Earlier versions tried to detect titles, key/value pairs, and tables
    from plain text via regex heuristics, then rewrote those lines as
    Markdown (#, **bold**, | tables |). That guessing is exactly what made
    output *less* trustworthy: e.g. the table heuristic inferred column
    counts and headers from trailing numeric tokens, which misclassifies
    ordinary sentences ending in a number and can attach the wrong header
    to a column. Clients need exact content over a "nicer" structure, so
    this function now only trims trailing whitespace per line and collapses
    runs of blank lines — it never adds, removes, or reorders content."""
    raw_lines = [l.rstrip() for l in text.split('\n')]

    out = []
    prev_blank = True
    for line in raw_lines:
        blank = not line.strip()
        if blank and prev_blank:
            continue
        out.append(line)
        prev_blank = blank

    return '\n'.join(out).strip() + '\n'
 
 
@app.post("/format")
def format_markdown(req: FormatRequest):
    """Returns {markdown, verified}. No external API call — markdown is
    generated deterministically from the input text, so it's faithful by
    construction. `verified: False` only happens when there's nothing
    usable to format, never because of an unverifiable LLM result."""
    if not req.text or len(req.text.strip()) < 5:
        return {"markdown": None, "verified": False, "reason": "empty_input"}
 
    try:
        markdown = format_markdown_local(req.text)
    except Exception as e:
        print("format_markdown: local formatting failed:", e)
        return {"markdown": None, "verified": False, "reason": "format_error"}
 
    if not markdown.strip():
        return {"markdown": None, "verified": False, "reason": "empty_output"}
 
    return {"markdown": markdown, "verified": True}