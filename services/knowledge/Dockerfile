FROM python:3.11-slim-bookworm
ENV PYTHONUNBUFFERED=1 HF_HOME=/models/huggingface TORCH_HOME=/models/torch XDG_CACHE_HOME=/models/cache
RUN apt-get update && apt-get install -y --no-install-recommends gosu libglib2.0-0 libgl1 libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY services/knowledge/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --upgrade pip==26.2.1
RUN --mount=type=cache,id=sufler-knowledge-pip,target=/root/.cache/pip pip install --retries 10 --resume-retries 10 --timeout 120 --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.lock
RUN useradd --create-home worker && mkdir -p /models && chown worker /models
COPY --chown=worker services/knowledge/main.py ./main.py
COPY --chmod=755 deploy/model-entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
EXPOSE 8002
CMD ["uvicorn", "main:app", "--host", "::", "--port", "8002", "--no-access-log"]
