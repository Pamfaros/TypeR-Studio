"""Run the existing TypeR MAT worker on Android via a local Termux connection."""

import argparse
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import sys
import threading
import traceback
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "desktop" / "mat"))
from mat_worker import infer, model_loader, read_image


MAX_JSON = 24 * 1024 * 1024
CHECKPOINT_SHA256 = "d960c4e6b3266b6b9fa74ee4458a9482160d54c06d7738696bc9a9e2b34c66dc"
API = "/sdcpp/v1"
JOB_PATH = re.compile(API + r"/jobs/([a-f0-9]{32})(/cancel)?")


class Cancelled(Exception):
    pass


class MatJobs:
    def __init__(self, runtime):
        self.runtime = runtime
        self.jobs = {}
        self.lock = threading.Lock()

    def submit(self, body):
        with self.lock:
            if any(job["status"] == "running" for job in self.jobs.values()):
                return None
            if len(self.jobs) >= 4:
                del self.jobs[next(iter(self.jobs))]
            job_id = uuid4().hex
            job = {"status": "running", "cancel_requested": False}
            self.jobs[job_id] = job
        threading.Thread(target=self.generate, args=(job, body), daemon=True).start()
        return job_id

    def get(self, job_id, cancel=False):
        with self.lock:
            job = self.jobs.get(job_id)
            if job and cancel and job["status"] == "running":
                job["cancel_requested"] = True
            return dict(job) if job else None

    def generate(self, job, body):
        def progress(step, total):
            with self.lock:
                if job["cancel_requested"]:
                    raise Cancelled()
                job["progress"] = {"phase": "tile", "step": step, "total": total}

        try:
            image = read_image(body["init_image"], "RGB")
            mask = read_image(body["mask_image"], "L")
            progress(0, 0)
            png = infer(image, mask, *self.runtime, on_progress=progress)
            encoded = base64.b64encode(png).decode("ascii")
            if len(encoded) >= MAX_JSON - 4096:
                raise ValueError("Select a smaller region.")
            with self.lock:
                if job["cancel_requested"]:
                    raise Cancelled()
                job.update(status="completed", result={"images": [{"b64_json": encoded}]})
        except Cancelled:
            with self.lock:
                job["status"] = "cancelled"
        except Exception as error:
            traceback.print_exc()
            with self.lock:
                job.update(status="failed", error={"message": str(error)})


class MatHandler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(15)
        super().setup()

    def send_json(self, status, value):
        data = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def fail(self, status, message):
        self.send_json(status, {"error": {"message": message}})

    def do_GET(self):
        if self.path == API + "/capabilities":
            self.send_json(200, {"model": "mat-512", "version": 1})
            return
        route = JOB_PATH.fullmatch(self.path)
        job = self.server.jobs.get(route[1]) if route and not route[2] else None
        if job is None:
            self.fail(404, "Local MAT job not found.")
        else:
            self.send_json(200, job)

    def do_POST(self):
        if self.headers.get_content_type() != "application/json":
            self.fail(415, "Expected JSON.")
            return
        route = JOB_PATH.fullmatch(self.path)
        if route and route[2]:
            job = self.server.jobs.get(route[1], cancel=True)
            if job is None:
                self.fail(404, "Local MAT job not found.")
            else:
                self.send_json(200, {"status": job["status"]})
            return
        if self.path != API + "/img_gen":
            self.fail(404, "Unknown local MAT route.")
            return

        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_JSON:
                self.fail(413, "Select a smaller region.")
                return
            body = json.loads(self.rfile.read(size))
            if not all(isinstance(body.get(field), str) and body[field] for field in ("init_image", "mask_image")):
                raise ValueError("Missing image or mask.")
        except (ValueError, AttributeError):
            self.fail(400, "Expected an image and mask.")
            return
        job_id = self.server.jobs.submit(body)
        if job_id is None:
            self.fail(409, "MAT is already processing a selection.")
        else:
            self.send_json(202, {"id": job_id})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    args = parser.parse_args()

    checksum = hashlib.sha256()
    with args.weights.open("rb") as weights:
        for chunk in iter(lambda: weights.read(1024 * 1024), b""):
            checksum.update(chunk)
    if checksum.hexdigest() != CHECKPOINT_SHA256:
        parser.error("The MAT checkpoint does not match the expected Places_512_FullData.pkl.")

    os.environ["TYPER_MAT_DEVICE"] = "cpu"
    sys.path.insert(0, str(args.repo.resolve()))
    with ThreadingHTTPServer(("127.0.0.1", 7870), MatHandler) as server:
        server.jobs = MatJobs(model_loader(str(args.repo.resolve()), str(args.weights.resolve())))
        print("TypeR MAT ready on 127.0.0.1:7870", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
