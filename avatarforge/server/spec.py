"""The shared avatar description (../shared/avatar-spec.json), mirrored from web/src/avatar/spec.js."""
import json
import re
from pathlib import Path

SHARED = Path(__file__).resolve().parent.parent / "shared"
SPEC = json.loads((SHARED / "avatar-spec.json").read_text())
PHYSIQUES = json.loads((SHARED / "physiques.json").read_text())
COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def flatten(obj, prefix=""):
    out = {}
    for k, v in obj.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out


DEFAULTS = flatten(SPEC["defaults"])
ENUMS = SPEC["enums"]
MAX_TAGS = SPEC["maxVibeTags"]


def kind_of(key):
    if key in ENUMS:
        return "enum"
    d = DEFAULTS.get(key)
    if isinstance(d, bool):
        return None
    if isinstance(d, (int, float)):
        return "slider"
    if isinstance(d, str) and d.startswith("#"):
        return "color"
    if isinstance(d, list):
        return "tags"
    return None


def sanitize_patch(patch):
    """Keep only valid entries: sliders clamped to 0..1, well-formed colours and enums, unknown keys dropped."""
    clean = {}
    if not isinstance(patch, dict):
        return clean
    for key, v in patch.items():
        kind = kind_of(key)
        if kind == "slider" and isinstance(v, (int, float)) and not isinstance(v, bool) and v == v:
            clean[key] = round(min(1.0, max(0.0, float(v))), 3)
        elif kind == "color" and isinstance(v, str) and COLOR.match(v):
            clean[key] = v.lower()
        elif kind == "enum" and v in ENUMS[key]:
            clean[key] = v
        elif kind == "tags" and isinstance(v, list):
            tags = []
            for t in v:
                if isinstance(t, str) and t.strip() and t.strip().lower() not in tags:
                    tags.append(t.strip().lower())
            clean[key] = tags[:MAX_TAGS]
    return clean


def schema_for_prompt():
    """A compact description of every key the copilot may set."""
    lines = []
    for key, d in DEFAULTS.items():
        kind = kind_of(key)
        if kind == "slider":
            lines.append(f"- {key}: number 0..1 (0.5 neutral)")
        elif kind == "color":
            lines.append(f"- {key}: hex colour like #aa3322")
        elif kind == "enum":
            lines.append(f"- {key}: one of {', '.join(ENUMS[key])}")
        elif kind == "tags":
            lines.append(f"- {key}: list of up to {MAX_TAGS} short style tags, e.g. cyberpunk, fantasy, cute, royal, luxury")
    return "\n".join(lines)
