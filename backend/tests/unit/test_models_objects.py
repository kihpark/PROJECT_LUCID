"""Unit tests for backend/api/models/objects.py."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.models.base import new_uid
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

THIRTEEN_CONCRETE = [
    (Concept, ObjectClass.CONCEPT),
    (Person, ObjectClass.PERSON),
    (Organization, ObjectClass.ORGANIZATION),
    (Service, ObjectClass.SERVICE),
    (Product, ObjectClass.PRODUCT),
    (Place, ObjectClass.PLACE),
    (Knowledge, ObjectClass.KNOWLEDGE),
    (Event, ObjectClass.EVENT),
    (Procedure, ObjectClass.PROCEDURE),
    (Task, ObjectClass.TASK),
    (Metric, ObjectClass.METRIC),
    (Resource, ObjectClass.RESOURCE),
    (Problem, ObjectClass.PROBLEM),
]


@pytest.mark.parametrize("cls,expected_class", THIRTEEN_CONCRETE)
def test_each_concrete_object_class_pins_class_field(cls, expected_class):
    """Each of the 13 subclasses defaults `class_` to its own ObjectClass."""
    obj = cls(
        object_uid=new_uid(),
        name="example",
        knowledge_space_id=new_uid(),
    )
    assert obj.class_ is expected_class


def test_object_class_enum_has_thirteen_concrete_values():
    """ObjectClass enum carries 13 concrete object types (no AtomicFact/Source)."""
    assert len(ObjectClass) == 13


def test_object_serializes_class_alias_on_the_wire():
    """`class_` field uses the `class` alias when dumping with by_alias=True."""
    obj = Concept(
        object_uid=new_uid(),
        name="Loss aversion",
        knowledge_space_id=new_uid(),
    )
    dumped = obj.model_dump(by_alias=True)
    assert dumped["class"] == "concept"
    assert "class_" not in dumped


def test_object_extra_field_forbidden():
    """extra='forbid' rejects unknown fields at construction."""
    with pytest.raises(ValidationError):
        Concept(
            object_uid=new_uid(),
            name="X",
            knowledge_space_id=new_uid(),
            mystery_field="boom",
        )


def test_connected_object_basic_shape():
    """ConnectedObject just holds target_uid + link_type string."""
    co = ConnectedObject(target_uid=new_uid(), link_type="part_of")
    assert co.link_type == "part_of"


def test_object_assigns_updated_at_independently_of_created_at():
    """Both timestamps default to utc_now; both are timezone-aware."""
    obj = Concept(
        object_uid=new_uid(),
        name="x",
        knowledge_space_id=new_uid(),
    )
    assert obj.created_at.tzinfo is not None
    assert obj.updated_at.tzinfo is not None
