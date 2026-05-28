"""Lucid Pydantic models — the source of truth.

PR-1A-2: ontology + facts + links + validation + contradiction + source.
Built first (zero deps); imported by ES storage layer and API routes.
"""
from api.models.auth import (
    KnowledgeSpacePublic,
    LoginRequest,
    RegisterRequest,
    RegisterResponse,
    TokenResponse,
    UpdateSpaceRequest,
    UpdateUserSettingsRequest,
    UserPublic,
    UserSettingsResponse,
)
from api.models.base import UID, LucidBaseModel, utc_now
from api.models.contradiction import (
    ContradictionPair,
    ContradictionPattern,
    GatekeepingWarning,
)
from api.models.disambiguation import (
    DecisionMethod,
    DisambiguationCandidate,
    DisambiguationCard,
    DisambiguationLog,
)
from api.models.facts import (
    AtomicFact,
    EditRecord,
    FactNode,
    FactType,
)
from api.models.links import (
    FactFactLinkType,
    FactObjectLinkType,
    LinkRecord,
    ObjectObjectLinkType,
)
from api.models.objects import (
    Concept,
    ConnectedObject,
    Event,
    Knowledge,
    Metric,
    Object,
    ObjectClass,
    Organization,
    Person,
    Place,
    Problem,
    Procedure,
    Product,
    Resource,
    Service,
    Task,
)
from api.models.source import Source, SourcePolicy, SourceType
from api.models.validation import ValidationMethod, ValidationRecord

__all__ = [
    # base
    "LucidBaseModel",
    "UID",
    "utc_now",
    # objects (12-ish concrete classes; see PR notes)
    "ObjectClass",
    "Object",
    "ConnectedObject",
    "Concept",
    "Person",
    "Organization",
    "Service",
    "Product",
    "Place",
    "Knowledge",
    "Event",
    "Procedure",
    "Task",
    "Metric",
    "Resource",
    "Problem",
    # facts
    "FactType",
    "AtomicFact",
    "FactNode",
    "EditRecord",
    # links
    "FactObjectLinkType",
    "ObjectObjectLinkType",
    "FactFactLinkType",
    "LinkRecord",
    # validation
    "ValidationMethod",
    "ValidationRecord",
    # contradiction
    "ContradictionPattern",
    "ContradictionPair",
    "GatekeepingWarning",
    # source
    "SourcePolicy",
    "SourceType",
    "Source",
    # auth (Sprint 1B)
    "RegisterRequest",
    "RegisterResponse",
    "LoginRequest",
    "TokenResponse",
    "UserPublic",
    "KnowledgeSpacePublic",
    "UpdateSpaceRequest",
    "UserSettingsResponse",
    "UpdateUserSettingsRequest",
    # disambiguation (DCR-001)
    "DecisionMethod",
    "DisambiguationCandidate",
    "DisambiguationCard",
    "DisambiguationLog",
]
