"""Dependency-free compact term filter shared by the cloud ingestion script."""

from __future__ import annotations

import re

TERM_FILTER_BYTES = 2048
TERM_FILTER_HASHES = 5


def create_term_filter(value: str, byte_length: int = TERM_FILTER_BYTES) -> bytes:
    if byte_length <= 0:
        raise ValueError("byte_length must be positive")
    result = bytearray(byte_length)
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
            bit %= byte_length * 8
            result[bit >> 3] |= 1 << (bit & 7)
    return bytes(result)
