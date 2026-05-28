"""Lucid internal accuracy metrics (DCR-001).

M1 Extraction Precision     record_validate_decision
M2 Negation Error Rate      record_negation_correction
M3 Contradiction Recall     record_contradiction_confirmation

ALL three write anonymized aggregate rows: fact_uid + decision pattern
+ user_id only. No claim text, no source URL, no privately-identifying
data ever lands in these tables. Sprint 7 builds the dashboard on top
of these logs.
"""
from api.metrics.precision import (
    record_contradiction_confirmation,
    record_negation_correction,
    record_validate_decision,
)

__all__ = [
    "record_validate_decision",
    "record_negation_correction",
    "record_contradiction_confirmation",
]
