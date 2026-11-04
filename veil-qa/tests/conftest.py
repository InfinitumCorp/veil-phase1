import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

for tool_dir in ("veil-build/scripts", "veil-browser/tools", "veil-chrome/tools", "veil-update/tools"):
    sys.path.insert(0, str(ROOT / tool_dir))


@pytest.fixture
def root() -> Path:
    return ROOT
