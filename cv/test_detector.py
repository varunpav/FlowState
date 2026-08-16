"""
Unit tests for the pure geometry/decision logic in detector.py — no camera,
no opencv/numpy import, runnable with nothing but the stdlib:
`python -m unittest discover cv`.
"""

import unittest

from detector import mouth_zone_box, object_present_in_zone


class MouthZoneBoxTests(unittest.TestCase):
    def test_extends_downward_by_the_configured_factor_of_face_height(self):
        face = (100, 50, 80, 80)  # x, y, w, h
        zone = mouth_zone_box(face)
        # MOUTH_ZONE_EXTEND_FACTOR is 2.5 — zone height = 80 * 2.5 = 200.
        self.assertEqual(zone, (100, 50, 80, 200))

    def test_keeps_the_face_boxs_x_and_width(self):
        face = (30, 10, 60, 60)
        zone = mouth_zone_box(face)
        self.assertEqual(zone[0], face[0])
        self.assertEqual(zone[2], face[2])

    def test_starts_at_the_same_top_as_the_face_box(self):
        face = (30, 10, 60, 60)
        zone = mouth_zone_box(face)
        self.assertEqual(zone[1], face[1])


class ObjectPresentInZoneTests(unittest.TestCase):
    def test_true_when_changed_fraction_meets_the_threshold(self):
        # default min_fraction is 0.06 — exactly at the boundary counts.
        self.assertTrue(object_present_in_zone(changed_pixel_count=60, zone_area=1000, min_fraction=0.06))

    def test_false_when_changed_fraction_is_below_the_threshold(self):
        self.assertFalse(object_present_in_zone(changed_pixel_count=59, zone_area=1000, min_fraction=0.06))

    def test_false_when_the_zone_has_no_area(self):
        # Guards against a division by zero if a face box ever collapses to nothing.
        self.assertFalse(object_present_in_zone(changed_pixel_count=0, zone_area=0))

    def test_false_when_nothing_changed(self):
        self.assertFalse(object_present_in_zone(changed_pixel_count=0, zone_area=500))

    def test_true_when_the_entire_zone_changed(self):
        self.assertTrue(object_present_in_zone(changed_pixel_count=500, zone_area=500))


if __name__ == "__main__":
    unittest.main()
