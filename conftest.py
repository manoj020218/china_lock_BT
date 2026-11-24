"""Ensure the repository root is importable so ``tools`` and ``client`` packages
resolve when the test suite runs from any working directory."""

import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
