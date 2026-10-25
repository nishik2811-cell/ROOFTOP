"""Keyword parser used when NIM can't be reached, so the demo never dies on stage.

It understands the common phrasings ("sharper jaw", "spiky red hair", "a bit taller",
"muscular", "cyberpunk vibe"); everything else is left to the real copilot.
"""
import re

from spec import DEFAULTS, ENUMS, MAX_TAGS

COLORS = {
    "red": "#c0392b", "crimson": "#a3162b", "orange": "#e67e22", "ginger": "#c0622f", "yellow": "#f1c40f",
    "gold": "#d4a017", "golden": "#d4a017", "blonde": "#e8c77a", "blond": "#e8c77a", "green": "#27ae60",
    "teal": "#1abc9c", "cyan": "#22d3ee", "blue": "#2e6fd8", "navy": "#1f2d5a", "purple": "#8e44ad",
    "violet": "#7f3fbf", "pink": "#ff6fae", "magenta": "#d63384", "white": "#f2f2f2", "silver": "#c0c6cc",
    "grey": "#808890", "gray": "#808890", "black": "#151515", "brown": "#5b3a24", "auburn": "#7a2f1d",
}
SKIN = {"pale": "#f1d3c2", "fair": "#eac2a4", "light": "#e3b493", "olive": "#b98a62", "tan": "#b07b52",
        "brown": "#8d5a3b", "dark": "#5e3a25", "deep": "#3f2618"}
VIBES = ["cyberpunk", "fantasy", "cute", "royal", "luxury", "pirate", "knight", "punk", "gothic", "retro", "sporty", "mage"]

UP = r"(sharp|angular|chiseled|chiselled|defined|strong|big|large|huge|wide|broad|full|plump|thick|long|high|tall|prominent|pointy|raised|more|increase|bigger|larger|wider|broader|fuller|thicker|longer|higher|taller|sharper|stronger)"
DOWN = r"(soft|round|small|tiny|narrow|thin|short|low|flat|less|decrease|smaller|narrower|thinner|shorter|lower|softer|rounder|weaker|subtle)"

# (noun pattern, key, label)
FEATURES = [
    (r"jaw(line)?", "face.jawSharpness", "jaw"),
    (r"cheek ?bones?", "face.cheekbones", "cheekbones"),
    (r"eyes? (further|farther|wider) apart|eye spacing", "face.eyeSpacing", "eye spacing"),
    (r"eyes?", "face.eyeSize", "eyes"),
    (r"nose", "face.noseWidth", "nose"),
    (r"lips?|mouth", "face.lipFullness", "lips"),
    (r"forehead", "face.foreheadHeight", "forehead"),
    (r"chin", "face.chinLength", "chin"),
    (r"(eye)?brows?", "face.browHeight", "brows"),
    (r"face", "face.faceLength", "face"),
    (r"shoulders?", "body.shoulderWidth", "shoulders"),
    (r"hips?|waist", "body.hipWidth", "hips"),
    (r"legs?", "body.legLength", "legs"),
    (r"arms?", "body.armLength", "arms"),
    (r"torso", "body.torsoLength", "torso"),
    (r"height", "body.height", "height"),
]
PHYSIQUE = [
    (r"\b(muscular|buff|ripped|jacked|bodybuilder)\b", "muscular"),
    (r"\b(athletic|fit|toned|sporty)\b", "athletic"),
    (r"\b(slim|skinny|slender|lean)\b", "slim"),
    (r"\b(stocky|chunky|burly|bulky)\b", "stocky"),
    (r"\b(curvy|hourglass)\b", "curvy"),
]
HAIR_STYLES = [
    (r"\bspik(y|es|ed)\b|\bspiky\b", "spiky"),
    (r"\bbuzz(ed|cut| cut)?\b|\bshaved\b", "buzz"),
    (r"\bslick(ed)?([ -]?back)?\b", "slick-back"),
    (r"\bcurl(y|s)\b|\bafro\b|\bwavy\b", "curly"),
    (r"\blong\b(\s+\w+)?\s+hair\b|\bhair long\b", "long"),
    (r"\bshort\b(\s+\w+)?\s+hair\b", "short"),
]


def _amount(clause):
    if re.search(r"\b(a (little )?bit|slightly|a little|somewhat|tad)\b", clause):
        return 0.12
    if re.search(r"\b(very|much|really|super|extremely|way|a lot)\b", clause):
        return 0.38
    return 0.25


def _clamp(v):
    return round(min(1.0, max(0.0, v)), 3)


def parse(message, avatar=None):
    """Returns (patch, reply). `avatar` is the current flat avatar, for relative changes."""
    current = {**DEFAULTS, **(avatar or {})}
    text = message.lower()
    patch, said = {}, []
    clauses = [c.strip() for c in re.split(r",|;|\band\b|\bwith\b|\bplus\b|\.", text) if c.strip()]

    for clause in clauses:
        amt = _amount(clause)
        is_hair = re.search(r"\bhair|\bspik|\bcurl|\bbuzz|\bslick|\bafro|\bmohawk", clause)

        # Hair: style, colour, length, spikiness, volume.
        if is_hair:
            for pattern, style in HAIR_STYLES:
                if re.search(pattern, clause):
                    patch["hair.style"] = style
                    said.append(f"{style} hair")
                    break
            for name, hexv in COLORS.items():
                if re.search(rf"\b{name}\b", clause):
                    patch["hair.color"] = hexv
                    said.append(f"{name} hair colour")
                    break
            if re.search(r"\blonger\b", clause):
                patch["hair.length"] = _clamp(current["hair.length"] + amt)
                said.append("longer hair")
            elif re.search(r"\bshorter\b", clause):
                patch["hair.length"] = _clamp(current["hair.length"] - amt)
                said.append("shorter hair")
            if re.search(r"\bspikier\b|\bmore spik|\btaller spik|\bbigger spik", clause):
                patch["hair.spikiness"] = _clamp(current["hair.spikiness"] + amt)
            if re.search(r"\b(volume|fluffy|fluffier|bigger hair|messy)\b", clause):
                patch["hair.volume"] = _clamp(current["hair.volume"] + amt)
            continue

        # Skin tone.
        if re.search(r"\bskin|\bcomplexion", clause):
            for name, hexv in SKIN.items():
                if re.search(rf"\b{name}(er)?\b", clause):
                    patch["colors.skin"] = hexv
                    said.append(f"{name} skin")
                    break
            continue

        # Eye colour ("green eyes") before eye size.
        eye_color = next((n for n in COLORS if re.search(rf"\b{n} eyes?\b", clause)), None)
        if eye_color:
            patch["colors.eyes"] = COLORS[eye_color]
            said.append(f"{eye_color} eyes")
            continue

        # Clothes colours.
        cloth = re.search(r"\b(outfit|shirt|suit|jacket|clothes|top|hoodie|armou?r)\b", clause)
        pants = re.search(r"\b(pants|trousers|jeans|shorts|boots)\b", clause)
        color_name = next((n for n in COLORS if re.search(rf"\b{n}\b", clause)), None)
        if color_name and (cloth or pants or len(clause.split()) <= 2):
            key = "colors.secondary" if pants else "colors.primary"
            patch[key] = COLORS[color_name]
            said.append(f"{color_name} {'pants' if pants else 'outfit'}")
            continue

        # Physique presets.
        matched = False
        for pattern, physique in PHYSIQUE:
            if re.search(pattern, clause):
                patch["physique"] = physique
                said.append(f"{physique} build")
                matched = True
                break
        if re.search(r"\b(fat|chubby|heavier|bigger belly)\b", clause):
            patch["body.bodyFat"] = _clamp(current["body.bodyFat"] + amt)
            said.append("heavier build")
            matched = True

        # Face and body sliders.
        for noun, key, label in FEATURES:
            if not re.search(rf"\b({noun})\b", clause):
                continue
            if re.search(rf"\b{DOWN}\b", clause):
                patch[key] = _clamp(current[key] - amt)
                said.append(f"{'less' if key.endswith('Sharpness') else 'smaller'} {label}".replace("smaller jaw", "softer jaw"))
            elif re.search(rf"\b{UP}\b", clause):
                patch[key] = _clamp(current[key] + amt)
                said.append(f"{'sharper' if key.endswith('Sharpness') else 'bigger'} {label}")
            matched = True
            break
        if not matched:
            if re.search(r"\b(taller|tall)\b", clause):
                patch["body.height"] = _clamp(current["body.height"] + amt)
                said.append("taller")
            elif re.search(r"\b(shorter|short)\b", clause):
                patch["body.height"] = _clamp(current["body.height"] - amt)
                said.append("shorter")

        # Vibes.
        for vibe in VIBES:
            if re.search(rf"\b{vibe}\b", clause):
                tags = list(patch.get("vibe", current.get("vibe") or []))
                if vibe not in tags:
                    tags.append(vibe)
                patch["vibe"] = tags[-MAX_TAGS:]
                said.append(f"{vibe} vibe")

    if not patch:
        return {}, "Offline mode didn't catch that. Try something like \"sharper jaw, spiky red hair, muscular\"."
    return patch, "Done: " + ", ".join(dict.fromkeys(said)) + "."
