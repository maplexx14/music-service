from uuid import UUID


def uuid_for(value: int) -> str:
    """Stable UUIDs for fixtures that need a specific local database identity."""
    return str(UUID(int=value, version=4))
