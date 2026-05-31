# VousFin ML worker (B3). Build: docker build -t vousfin-ml-worker ./ml-worker
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

# libgomp is required by LightGBM at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .
RUN mkdir -p artifacts data

EXPOSE 8000
# 2 workers is a sane default; scale horizontally behind the queue (F8).
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
