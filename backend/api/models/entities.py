from pydantic import BaseModel


class EntitySuggestion(BaseModel):
    entity_id: str
    primary_label: str
    primary_lang: str
    score: float


class EntitySuggestionsResponse(BaseModel):
    items: list[EntitySuggestion]
