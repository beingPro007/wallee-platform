"""Read-only catalog orientation decisions, separate from desktop routing."""
import math


def classify_rotation(prediction, confidence, threshold=0.95):
    if prediction not in (0, 90, 180, 270):
        raise ValueError("Invalid rotation")
    if not math.isfinite(confidence) or not 0 <= confidence <= 1:
        raise ValueError("Invalid confidence")
    if not 0.85 <= threshold <= 1:
        raise ValueError("Threshold must be between 0.85 and 1")
    confident = confidence >= threshold
    candidate = confident and prediction != 0
    return {
        "pred_rotation": prediction,
        "confidence": confidence,
        "status": "rotation_candidate" if candidate else "upright" if confident else "uncertain",
        "rotation_candidate": candidate,
        "suggested_fix_rotation": -prediction if candidate else 0,
    }
