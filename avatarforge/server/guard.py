"""Safety checks on copilot messages: no copyrighted characters, no real people's likeness.

Two layers:
1. A built-in check (always on, instant, works offline).
2. NeMo Guardrails self-check input rail (when installed and NVIDIA_API_KEY is set), which
   catches what a word list cannot.
Art *styles* and genres ("anime", "cyberpunk", "like a knight") are always allowed.
"""
import logging
import os
import re
from pathlib import Path

log = logging.getLogger("avatarforge.guard")

# Named characters and franchises. Short on purpose: the guardrail model covers the long tail.
CHARACTERS = [
    "naruto", "sasuke", "goku", "vegeta", "luffy", "zoro", "pikachu", "sailor moon", "levi ackerman", "eren yeager",
    "gojo", "tanjiro", "spider-man", "spiderman", "iron man", "ironman", "batman", "superman", "wonder woman",
    "hulk", "thor", "captain america", "deadpool", "wolverine", "joker", "harry potter", "hermione", "darth vader",
    "yoda", "mickey mouse", "elsa", "mario", "luigi", "princess peach", "zelda", "link from", "sonic", "master chief",
    "kratos", "lara croft", "geralt", "pac-man", "shrek", "minion", "barbie", "hello kitty", "among us crewmate",
    "red crewmate", "fortnite skin", "jinx", "arcane", "genshin", "raiden shogun", "hu tao", "cloud strife", "tifa",
    "sephiroth", "solid snake", "doomguy", "steve from minecraft",
]
FRANCHISES = ["marvel", "disney", "pixar", "dc comics", "nintendo", "pokemon", "pokémon", "star wars", "dragon ball", "one piece"]
# Wanting to look like a specific real person.
REAL_PERSON = [
    r"\blook(s|ing)? (exactly )?like (my|a) (ex|neighbou?r|coworker|classmate|teacher|boss)\b",
    r"\b(celebrity|celeb|famous (actor|actress|singer|person|youtuber|streamer))\b",
    r"\b(taylor swift|elon musk|keanu reeves|beyonc[eé]|the rock|dwayne johnson|tom cruise|zendaya|bts|ronaldo|messi|obama|trump|modi|shah rukh|virat kohli|mrbeast)\b",
    r"\bsomeone else'?s (face|photo)\b",
]

COPYRIGHT_REASON = (
    "AvatarForge can't recreate copyrighted or trademarked characters. "
    "You can still ask for a style, like \"anime theme with spiky orange hair\"."
)
LIKENESS_REASON = (
    "AvatarForge can't copy a real person's likeness. Describe the features you want instead, "
    "or use the webcam on your own face."
)

RAIL_REASON = (
    "AvatarForge can't recreate copyrighted characters or a real person's likeness. "
    "Describe a style or the features you want instead."
)


def builtin_check(message):
    """Returns None if allowed, else the reason it was blocked."""
    text = message.lower()
    for name in CHARACTERS + FRANCHISES:
        if re.search(rf"(?<![a-z]){re.escape(name)}(?![a-z])", text):
            return COPYRIGHT_REASON
    for pattern in REAL_PERSON:
        if re.search(pattern, text):
            return LIKENESS_REASON
    return None


_rails = None
_rails_failed = False


def _load_rails():
    global _rails, _rails_failed
    if _rails is not None or _rails_failed:
        return _rails
    if not os.environ.get("NVIDIA_API_KEY") or os.environ.get("GUARDRAILS", "nemo") == "builtin":
        _rails_failed = True
        return None
    try:
        from nemoguardrails import LLMRails, RailsConfig  # optional dependency

        config = RailsConfig.from_path(str(Path(__file__).parent / "guardrails"))
        _rails = LLMRails(config)
    except Exception as e:  # missing package or bad config: keep the built-in layer only
        log.warning("NeMo Guardrails not active (%s); using the built-in check only", e)
        _rails_failed = True
    return _rails


def mode():
    return "nemo-guardrails + built-in" if _load_rails() else "built-in"


async def check(message):
    """Returns None if allowed, else the reason it was blocked."""
    reason = builtin_check(message)
    if reason:
        return reason
    rails = _load_rails()
    if rails is None:
        return None
    try:
        # Run only the input rail, so no reply is generated for allowed messages.
        result = await rails.generate_async(
            messages=[{"role": "user", "content": message}], options={"rails": ["input"]}
        )
        response = getattr(result, "response", result)
        if isinstance(response, list):
            content = response[-1].get("content", "") if response else ""
        elif isinstance(response, dict):
            content = response.get("content", "")
        else:
            content = str(response)
        if "BLOCKED" in content:
            return RAIL_REASON
    except Exception as e:
        log.warning("Guardrails call failed (%s); built-in check already passed", e)
    return None
