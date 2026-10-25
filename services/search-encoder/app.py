import numpy as np
import onnxruntime as ort
import logging
from logging.config import dictConfig
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from tokenizers import Tokenizer
from typing import List

LOGGING_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {
            "format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
            "datefmt": "%Y-%m-%d %H:%M:%S",
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "default",
            "stream": "ext://sys.stdout",
        },
    },
    "loggers": {
        "wallee": {"handlers": ["console"], "level": "INFO", "propagate": False},
        "uvicorn": {"handlers": ["console"], "level": "INFO"},
    },
}

dictConfig(LOGGING_CONFIG)
logger = logging.getLogger("wallee")

app = FastAPI()

TOKENIZER = None
SESSION = None

class TextRequest(BaseModel):
    text: str

def init_models(model_path: str, tokenizer_path: str):
    global TOKENIZER, SESSION
    TOKENIZER = Tokenizer.from_file(tokenizer_path)
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_options.intra_op_num_threads = 1
    SESSION = ort.InferenceSession(model_path, sess_options, providers=['CPUExecutionProvider'])

@app.on_event("startup")
async def startup_event():
    init_models("model.onnx", "tokenizer.json")
    logger.info("Application initialized and models loaded")

@app.post("/encode")
async def encode_text(request: TextRequest) -> List[float]:
    if TOKENIZER is None or SESSION is None:
        logger.error("Attempted encoding before model initialization")
        raise HTTPException(status_code=500, detail="State error")

    try:
        encoding = TOKENIZER.encode(request.text)
        ids = encoding.ids
        
        max_length = 77
        if len(ids) > max_length:
            ids = ids[:max_length]
        else:
            ids = ids + [0] * (max_length - len(ids))

        input_tensor = np.array([ids], dtype=np.int64)
        input_name = SESSION.get_inputs()[0].name
        outputs = SESSION.run(None, {input_name: input_tensor})

        vector = outputs[0].flatten().astype(float)
        norm = np.linalg.norm(vector)
        if norm > 0:
            vector = vector / norm

        logger.info(f"Generated embedding for text: '{request.text[:30]}...'")
        return vector.tolist()
    except Exception as e:
        logger.error(f"Inference error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))