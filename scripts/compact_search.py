"""Dependency-free compact term filter shared by the cloud ingestion script."""

from __future__ import annotations

import re

TERM_FILTER_BYTES = 2048
TERM_FILTER_HASHES = 5


def create_term_filter(value: str) -> bytes:
    result = bytearray(TERM_FILTER_BYTES)
    terms = set(re.findall(r"[a-z0-9][a-z0-9'-]{1,39}", value.lower()))
    for term in terms:
        first = 0x811C9DC5
        second = 0x9E3779B9
        for character in term:
            code = ord(character)
            first = ((first ^ code) * 0x01000193) & 0xFFFFFFFF
            second ^= code + 0x9E3779B9 + ((second << 6) & 0xFFFFFFFF) + (second >> 2)
            second &= 0xFFFFFFFF
        second |= 1
        for index in range(TERM_FILTER_HASHES):
            bit = (first + index * second + index * index) & 0xFFFFFFFF
            bit %= TERM_FILTER_BYTES * 8
            result[bit >> 3] |= 1 << (bit & 7)
    return bytes(result)
