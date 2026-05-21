"""12 Object Classes for the Lucid ontology.

PO directive 2026-05-21 listed 13 concrete subclasses under "12 구체 class":
Concept, Person, Organization, Service, Product, Place, Knowledge, Event,
Procedure, Task, Metric, Resource, Problem. We implement all 13; the
"12" headcount is a small PO-side inconsistency carried forward (the
historical "12 ontology classes" from structure-stage-spec.md counted
Entity as one parent of 5 subs plus AtomicFact + 5 others = 12).

`AtomicFact` and `Source` are object-like but live in their own modules
because they have distinct lifecycles (facts decompose; sources annotate
provenance).
"""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import Field

from api.models.base import UID, LucidBaseModel, utc_now


class ObjectClass(StrEnum):
    """Concrete object types for the lucid_objects ES index `class` field."""

    CONCEPT = "concept"
    PERSON = "person"
    ORGANIZATION = "organization"
    SERVICE = "service"
    PRODUCT = "product"
    PLACE = "place"
    KNOWLEDGE = "knowledge"
    EVENT = "event"
    PROCEDURE = "procedure"
    TASK = "task"
    METRIC = "metric"
    RESOURCE = "resource"
    PROBLEM = "problem"


class ConnectedObject(LucidBaseModel):
    """Edge from an Object to another Object, embedded in the source Object.

    The `link_type` is constrained to the four Object-to-Object link types
    (PART_OF, INSTANCE_OF, LOCATED_IN, HAS_ROLE); see api.models.links.
    """

    target_uid: UID
    link_type: str  # validated against ObjectObjectLinkType at the API layer


class Object(LucidBaseModel):
    """Base Object node. Concrete subclasses pin `class_`.

    Stored in the lucid_objects ES index (one document per Object). The
    `class_` field uses the `class` alias on the wire because `class` is a
    Python keyword.
    """

    object_uid: UID
    class_: ObjectClass = Field(alias="class")
    name: str
    name_en: str | None = None
    properties: dict[str, Any] = Field(default_factory=dict)
    fact_uids: list[UID] = Field(default_factory=list)
    connected_objects: list[ConnectedObject] = Field(default_factory=list)
    knowledge_space_id: UID
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


# --- 13 concrete subclasses (one-line defaults pinning class_) -------

class Concept(Object):
    class_: ObjectClass = Field(default=ObjectClass.CONCEPT, alias="class")


class Person(Object):
    class_: ObjectClass = Field(default=ObjectClass.PERSON, alias="class")


class Organization(Object):
    class_: ObjectClass = Field(default=ObjectClass.ORGANIZATION, alias="class")


class Service(Object):
    class_: ObjectClass = Field(default=ObjectClass.SERVICE, alias="class")


class Product(Object):
    class_: ObjectClass = Field(default=ObjectClass.PRODUCT, alias="class")


class Place(Object):
    class_: ObjectClass = Field(default=ObjectClass.PLACE, alias="class")


class Knowledge(Object):
    class_: ObjectClass = Field(default=ObjectClass.KNOWLEDGE, alias="class")


class Event(Object):
    class_: ObjectClass = Field(default=ObjectClass.EVENT, alias="class")


class Procedure(Object):
    class_: ObjectClass = Field(default=ObjectClass.PROCEDURE, alias="class")


class Task(Object):
    class_: ObjectClass = Field(default=ObjectClass.TASK, alias="class")


class Metric(Object):
    class_: ObjectClass = Field(default=ObjectClass.METRIC, alias="class")


class Resource(Object):
    class_: ObjectClass = Field(default=ObjectClass.RESOURCE, alias="class")


class Problem(Object):
    class_: ObjectClass = Field(default=ObjectClass.PROBLEM, alias="class")
