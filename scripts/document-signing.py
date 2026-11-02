#!/usr/bin/env python3
"""Run the owner's private docsign installation; never discover agent code."""
import importlib.util
from pathlib import Path
import sys

skill = Path(sys.argv[1])
script = skill / "scripts/docsign.py"
spec = importlib.util.spec_from_file_location("docsign", script)
docsign = importlib.util.module_from_spec(spec)
spec.loader.exec_module(docsign)
linux_font = Path("/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf")
if linux_font.is_file():
    docsign.CYR_FONT = str(linux_font)
sys.argv = [str(script), *sys.argv[2:]]
raise SystemExit(docsign.main())
