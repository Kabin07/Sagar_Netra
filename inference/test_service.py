"""
Checks that the inference service returns the model's genuine output.

    python -m unittest inference/test_service.py -v      (from the repository root)

The service's segment() result is compared against a direct, independent
ultralytics prediction on the same image with the same settings.
"""
import os
import sys
import unittest
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault("SN_INFERENCE_TOKEN", "unit-test-token-not-used-for-http")
import service  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
IMAGE = ROOT / "demo_inputs_net" / "vid_000052_frame0000082.jpg"


@unittest.skipUnless(service.MODEL_PATH.exists(), "trained checkpoint not present")
class ServiceOutputTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        service.STATE.load()
        if service.STATE.model is None:
            raise unittest.SkipTest(f"model failed to load: {service.STATE.error}")

    def test_class_list_matches_classes_json(self):
        self.assertEqual(service.STATE.names, service.EXPECTED_CLASSES)
        self.assertEqual(len(service.STATE.names), 22)
        self.assertEqual(service.STATE.names[21], "trash_net")

    @unittest.skipUnless(IMAGE.exists(), "demo image not present")
    def test_matches_direct_ultralytics_prediction(self):
        from ultralytics import YOLO

        raw = IMAGE.read_bytes()
        out = service.segment(raw, conf=0.25, imgsz=service.STATE.imgsz)

        direct = YOLO(str(service.MODEL_PATH)).predict(
            cv2.imread(str(IMAGE)), conf=0.25, iou=service.NMS_IOU, imgsz=service.STATE.imgsz,
            retina_masks=True, verbose=False)[0]
        want = sorted((int(c), round(float(s), 5)) for c, s in zip(direct.boxes.cls, direct.boxes.conf))
        got = sorted((d["class_index"], d["confidence"]) for d in out["detections"])
        self.assertTrue(want, "model produced no detections on the ghost-net frame")
        self.assertEqual(got, want)
        for d in out["detections"]:
            self.assertEqual(d["class_name"], service.EXPECTED_CLASSES[d["class_index"]])
            self.assertIsNotNone(d["mask"])
            self.assertGreater(d["mask"]["area_px"], 0)

    def test_rejects_undecodable_bytes(self):
        with self.assertRaises(service.BadRequest):
            service.segment(b"\xff\xd8\xff\xe0" + b"\x07" * 4000, conf=0.25, imgsz=service.STATE.imgsz)


if __name__ == "__main__":
    unittest.main()
