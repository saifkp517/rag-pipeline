"""Per-bot guardrail configuration.

Placeholder: the shape and the call sites are wired up, the checks are not
implemented yet. `check_message` is already called on every chat turn, so
filling in the body is all that's needed to make guardrails live.
"""

from typing import Any

DEFAULT_GUARDRAILS: dict[str, Any] = {
    "blocked_topics": [],
    "refusal_message": "I can't help with that.",
    "max_response_tokens": None,
}


def normalize(guardrails: dict[str, Any] | None) -> dict[str, Any]:
    return {**DEFAULT_GUARDRAILS, **(guardrails or {})}


def check_message(guardrails: dict[str, Any], message: str) -> str | None:
    """Return a refusal string to short-circuit the turn, or None to allow it."""
    return None


def system_prompt_suffix(guardrails: dict[str, Any]) -> str:
    """Extra instructions appended to a bot's system prompt."""
    return ""
