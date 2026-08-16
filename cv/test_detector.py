"""
Unit tests for the pure geometry in detector.py — no camera, no opencv import,
runnable with nothing but the stdlib: `python -m unittest discover cv`.
"""

import unittest

from detector import is_drinking


class IsDrinkingTests(unittest.TestCase):
    def test_object_centered_directly_below_the_face_counts(self):
        face = (100, 50, 80, 80)  # x, y, w, h
        bottle_right_below_chin = (120, 130, 40, 60)  # center inside the extended zone
        self.assertTrue(is_drinking(face, bottle_right_below_chin))

    def test_object_far_below_the_face_does_not_count(self):
        face = (100, 50, 80, 80)
        bottle_at_waist_height = (120, 400, 40, 60)
        self.assertFalse(is_drinking(face, bottle_at_waist_height))

    def test_object_beside_the_face_horizontally_does_not_count(self):
        face = (100, 50, 80, 80)
        bottle_off_to_the_side = (400, 60, 40, 60)
        self.assertFalse(is_drinking(face, bottle_off_to_the_side))

    def test_object_overlapping_the_face_itself_counts(self):
        # Held right up at mouth height, inside the face box's own bounds.
        face = (100, 50, 80, 80)
        bottle_at_mouth = (130, 90, 30, 30)
        self.assertTrue(is_drinking(face, bottle_at_mouth))

    def test_object_just_past_the_extended_zone_does_not_count(self):
        # extended_bottom = fy + fh * 2.5 = 50 + 80*2.5 = 250
        face = (100, 50, 80, 80)
        just_inside = (120, 240, 10, 10)  # center y = 245, inside
        just_outside = (120, 260, 10, 10)  # center y = 265, outside
        self.assertTrue(is_drinking(face, just_inside))
        self.assertFalse(is_drinking(face, just_outside))


if __name__ == "__main__":
    unittest.main()
