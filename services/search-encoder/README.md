---
title: Wallee Search
emoji: 🏆
colorFrom: purple
colorTo: yellow
sdk: docker
pinned: false
short_description: wallee-search-embedding
---

Check out the configuration reference at https://huggingface.co/docs/hub/spaces-config-reference

## Monorepo usage

Standalone ONNX text embedding service, retained from the original Hugging Face Space. Restore the ignored `model.onnx` using the root `scripts/assets.py`, then build this directory with Docker. `POST /encode` accepts `{"text": "mountains"}` and returns a normalized embedding. The service listens on port 7860.

The current mobile application performs text encoding through its Rust integration. This service is retained for other consumers. Its original Space is not deleted by this migration.
