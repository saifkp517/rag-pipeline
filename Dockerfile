# Backend only (FastAPI query service + ingest pipeline). The Next.js
# client is deployed separately on Vercel and is not part of this image.
FROM python:3.12-slim

WORKDIR /app

# CPU-only torch, installed separately from PyPI's default (CUDA-bundled,
# multi-GB) wheel - the cross-encoder reranker only needs CPU inference.
RUN pip install --no-cache-dir torch==2.14.0 --index-url https://download.pytorch.org/whl/cpu

COPY query-processing/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Bake the cross-encoder weights into the image so the container doesn't
# need to hit huggingface.co on every cold start.
RUN python -c "\
from transformers import AutoModelForSequenceClassification, AutoTokenizer; \
AutoModelForSequenceClassification.from_pretrained('cross-encoder/ms-marco-TinyBERT-L2'); \
AutoTokenizer.from_pretrained('cross-encoder/ms-marco-TinyBERT-L2')"

COPY info-processing ./info-processing
COPY query-processing ./query-processing

WORKDIR /app/query-processing
EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
