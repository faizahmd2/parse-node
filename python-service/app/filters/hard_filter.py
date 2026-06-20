import re
from bs4 import BeautifulSoup

# Known marketing/newsletter senders - expandable
MARKETING_DOMAINS = {
    'mailchimp.com', 'sendgrid.net', 'klaviyo.com',
    'constantcontact.com', 'campaignmonitor.com',
    'substack.com', 'beehiiv.com', 'convertkit.com',
    'amazonses.com', 'bounce.linkedin.com',
    'notifications.google.com', 'mailer.notion.so'
}

SPAM_SUBJECT_PATTERNS = [
    r'unsubscribe',
    r'newsletter',
    r'weekly digest',
    r'monthly update',
    r'you\'re invited',
    r'limited time offer',
    r'% off',
    r'click here',
    r'confirm your (email|subscription)',
    r'verify your email',
    r'no.?reply',
    r'do.?not.?reply',
]

MARKETING_BODY_SIGNALS = [
    'unsubscribe',
    'view in browser',
    'view this email in your browser',
    'email preferences',
    'manage your preferences',
    'you received this because',
    'you are receiving this',
    'to stop receiving',
]

def extract_sender_domain(from_address: str) -> str:
    match = re.search(r'@([\w.-]+)', from_address or '')
    return match.group(1).lower() if match else ''

def clean_html(raw: str) -> str:
    soup = BeautifulSoup(raw, 'html.parser')
    # Remove style, script, head blocks entirely
    for tag in soup(['style', 'script', 'head', 'meta', 'link']):
        tag.decompose()
    text = soup.get_text(separator=' ')
    # Collapse whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def hard_filter(subject: str, body: str, from_address: str) -> dict:
    """
    Returns {passed: bool, reason: str}
    """
    subject = (subject or '').lower()
    from_address = (from_address or '').lower()
    sender_domain = extract_sender_domain(from_address)

    # 1. Known marketing domain
    if sender_domain in MARKETING_DOMAINS:
        return {"passed": False, "reason": f"marketing_domain:{sender_domain}"}

    # 2. No-reply sender
    if re.search(r'no.?reply|do.?not.?reply', from_address):
        return {"passed": False, "reason": "noreply_sender"}

    # 3. Spam subject patterns
    for pattern in SPAM_SUBJECT_PATTERNS:
        if re.search(pattern, subject):
            return {"passed": False, "reason": f"spam_subject:{pattern}"}

    # 4. Marketing body signals (check raw body before cleaning)
    body_lower = body.lower()
    for signal in MARKETING_BODY_SIGNALS:
        if signal in body_lower:
            return {"passed": False, "reason": f"marketing_body:{signal}"}

    return {"passed": True, "reason": "passed"}


def extract_clean_text(subject: str, body: str) -> dict:
    """
    Clean HTML, assess quality, return usable text.
    """
    # Clean HTML if present
    if bool(BeautifulSoup(body, 'html.parser').find()):
        clean_body = clean_html(body)
    else:
        clean_body = re.sub(r'\s+', ' ', body).strip()

    # Quality checks
    word_count = len(clean_body.split())
    
    if word_count < 5:
        return {"quality": "too_short", "text": None, "word_count": word_count}
    
    if word_count > 2000:
        # Truncate very long emails — first 500 words carry the intent
        clean_body = ' '.join(clean_body.split()[:500])

    # Link density check — too many URLs = promotional
    url_count = len(re.findall(r'https?://', clean_body))
    if url_count > 5:
        return {"quality": "too_many_links", "text": None, "word_count": word_count}

    # Combine subject + body for classification
    full_text = f"{subject}. {clean_body}" if subject else clean_body

    return {
        "quality": "good",
        "text": full_text,
        "word_count": word_count
    }