# 1. Use Python 3.11 to support onnxruntime 1.20+
FROM python:3.11-slim

WORKDIR /app

# 2. Optimized caching: Copy requirements first
COPY requirements.txt .

# 3. Install latest dependencies
RUN pip install --no-cache-dir -r requirements.txt

# 4. Copy your model and code
COPY . .

ENV PYTHONUNBUFFERED=1

# 5. Run the app
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]