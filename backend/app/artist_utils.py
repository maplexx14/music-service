"""Общие утилиты для нормализации имён артистов.

Используются в recommendations.py, flow.py и diversity.py для
единообразного сравнения имён артистов из разных источников
(SoundCloud/YT Music отдают одно имя в разном регистре/формате).
"""
import re


def artist_key(name: str) -> str:
    """Нормализованный ключ артиста: lowercase, trim, одинарные пробелы."""
    return re.sub(r"\s+", " ", (name or "").strip().lower())
