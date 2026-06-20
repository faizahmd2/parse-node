import numpy as np

DEFAULT_IMPORTANT_SEEDS = [
    "urgent action required",
    "payment failed",
    "account suspended",
    "interview scheduled",
    "job offer",
    "deadline today",
    "meeting cancelled",
    "your order has been cancelled",
    "security alert",
    "password reset",
    "legal notice",
    "court date",
    "medical appointment",
    "prescription ready",
    "flight cancelled",
    "booking confirmation urgent",
    "response needed",
    "please reply",
    "time sensitive",
    "final notice",
]

def semantic_score(
    text,
    model,
    default_seed_embeddings,
    client_seeds=None
):

    text_embedding = model.encode(
        [text],
        normalize_embeddings=True
    )[0]

    # If custom seeds are provided
    if client_seeds:

        seed_embeddings = model.encode(
            client_seeds,
            normalize_embeddings=True
        )

        similarities = seed_embeddings @ text_embedding

        seed_list = client_seeds

    else:

        similarities = (
            default_seed_embeddings @ text_embedding
        )

        seed_list = DEFAULT_IMPORTANT_SEEDS

    idx = similarities.argmax()

    score = float(similarities[idx])

    return {
        "score": round(score, 4),

        "best_match": seed_list[idx],

        "passed": score >= 0.45
    }