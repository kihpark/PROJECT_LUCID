# Elasticsearch image with nori plugin

Lucid uses Elasticsearch 8.11 with the official `analysis-nori` plugin
for Korean morphological analysis.

## Why a custom image

Plugins must be installed at image build time on Elasticsearch 8.x.
This Dockerfile extends the official image and installs `analysis-nori`
once so the container starts cleanly without network access.

## Build

`docker compose build elasticsearch` from the repo root.

## Verify nori is loaded

```bash
docker compose up -d elasticsearch
curl -sS -XPOST 'http://localhost:9200/_analyze'   -H 'Content-Type: application/json'   -d '{"analyzer":"nori","text":"ì§ì ê·¸ëí ê²ì¦"}'
```

Expected tokens: `ì§ì`, `ê·¸ëí`, `ê²ì¦` (지식, 그래프, 검증).
