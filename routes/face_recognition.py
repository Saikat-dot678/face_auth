import insightface
from insightface.app import FaceAnalysis
import cv2
import numpy as np
import sys
import json
import os



app = FaceAnalysis(name="buffalo_l")
app.prepare(ctx_id=-1)  # -1 means CPU, use 0 for GPU if available

print("Models loaded successfully!")

mode = sys.argv[1]  # register or verify
user_id = sys.argv[2]
image_paths = sys.argv[3:]

embeddings = []
failed_images = []

for img_path in image_paths:
    img = cv2.imread(img_path)
    faces = app.get(img)

    if not faces:
        failed_images.append(img_path)
        continue

    # Choose the largest detected face (best for angled images too)
    face = max(faces, key=lambda f: f.bbox[2] - f.bbox[0])
    emb = face.embedding.astype(np.float32).tolist()
    embeddings.append(emb)

# === Registration Mode ===
if mode == "register":
    if len(embeddings) < 6:
        print(json.dumps({
            "error": f"Too few valid face images for registration (required: 6, found: {len(embeddings)}).",
            "failed_images": failed_images
        }))
        exit(1)

    avg_embedding = np.mean(embeddings, axis=0)
    np.save(f"embeddings/{user_id}.npy", avg_embedding)
    print(json.dumps({ "success": True }))
    exit(0)

# === Verification Mode ===
elif mode == "verify":
    if len(embeddings) == 0:
        print(json.dumps({ "match": False }))
        exit(0)

    stored_embedding = np.load(f"embeddings/{user_id}.npy")
    current_embedding = embeddings[0]

    sim = np.dot(stored_embedding, current_embedding) / (np.linalg.norm(stored_embedding) * np.linalg.norm(current_embedding))
    match = sim > 0.6  # You can tweak this threshold
    print(json.dumps({ "match": bool(match), "similarity": sim }))
    exit(0)
