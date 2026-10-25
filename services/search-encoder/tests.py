import requests
import time
import sys

def log(msg):
    print(f"--- {msg} ---", flush=True)

def wait_for_server(url, timeout=30):
    start = time.time()
    while time.time() - start < timeout:
        try:
            res = requests.get(url.replace("/encode", "/docs"), timeout=2)
            if res.status_code == 200:
                log("Server is UP and Ready")
                return True
        except:
            pass
        log("Waiting for server to initialize model...")
        time.sleep(2)
    return False

def run_tests():
    url = "http://localhost:7860/encode"
    
    if not wait_for_server(url):
        log("ERROR: Server timed out")
        sys.exit(1)

    test_cases = [
        {"name": "Standard Text", "payload": {"text": "Wallee search engine"}},
        {"name": "Long Text", "payload": {"text": "This is a much longer sentence to test if the 77 token truncation and padding logic works correctly inside the ONNX model."}},
        {"name": "Empty String", "payload": {"text": ""}}
    ]

    for case in test_cases:
        log(f"Testing: {case['name']}")
        try:
            response = requests.post(url, json=case['payload'], timeout=10)
            if response.status_code == 200:
                vector = response.json()
                log(f"SUCCESS | Vector Size: {len(vector)} | Norm: {sum(x*x for x in vector)**0.5:.4f}")
                # Verify dimensions (assuming 768)
                if len(vector) != 768:
                    log(f"DIMENSION MISMATCH: Expected 768, got {len(vector)}")
            else:
                log(f"FAILED | Status: {response.status_code} | Body: {response.text}")
        except Exception as e:
            log(f"EXCEPTION | {e}")

if __name__ == "__main__":
    log("Test Suite Started")
    run_tests()
    log("Test Suite Finished")