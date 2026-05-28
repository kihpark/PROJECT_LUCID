FROM python:3.11-slim

WORKDIR /app

# System deps for capture libraries (lxml, Pillow, audio transcription).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Preload Whisper 'small' model into /models so the first /api/capture
# YouTube-no-transcript path is fast (saves ~30s of first-run download
# on every fresh container start). ~244 MB image size cost.
ENV FASTER_WHISPER_DOWNLOAD_DIR=/models
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('small', download_root='/models', device='cpu')"

COPY . .

EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
