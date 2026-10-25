---
title: WalleeClassification
emoji: 🏆
colorFrom: red
colorTo: red
sdk: gradio
sdk_version: 5.49.1
app_file: app.py
pinned: false
short_description: 'An Api For '
---

Check out the configuration reference at https://huggingface.co/docs/hub/spaces-config-reference

## Legacy service

This is the earlier standalone Gradio classifier, retained for reference and existing consumers. The platform's processing pipeline uses `services/image-processing/app/services/classifier.py` instead. The models and category sets differ.

Install `requirements.txt` in an isolated Python environment and run `python app.py`. The existing Hugging Face deployment is independent of the GitHub consolidation.
