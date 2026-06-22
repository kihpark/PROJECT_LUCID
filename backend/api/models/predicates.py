from pydantic import BaseModel


class PredicateEntry(BaseModel):
    code: str
    label_ko: str
    label_en: str


class PredicatesListResponse(BaseModel):
    items: list[PredicateEntry]
