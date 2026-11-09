"""Database identifiers are UUIDs, represented as strings at application boundaries."""

from typing import Annotated
from uuid import UUID, uuid4

from pydantic import AfterValidator, Field


def new_uuid() -> str:
    return str(uuid4())


def normalize_uuid(value: str) -> str:
    """Validate and canonicalize an API or cache identifier."""
    return str(UUID(value))


def uuid_or_none(value: object) -> str | None:
    """Distinguish a database UUID from a provider ID such as ``ytmusic:...``."""
    if isinstance(value, bytes):
        value = value.decode("ascii", errors="replace")
    if not isinstance(value, str):
        return None
    try:
        return normalize_uuid(value)
    except ValueError:
        return None


UUIDString = Annotated[
    str,
    AfterValidator(normalize_uuid),
    Field(json_schema_extra={"format": "uuid"}),
]
