from pydantic import BaseModel, Field


class AssistantBriefRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=2000)
    space_id: str


class VerifiedFactEntry(BaseModel):
    fact_uid: str
    subject: str
    predicate_label: str
    object: str
    sources: list[str] = Field(default_factory=list)


class AssistantBriefResponse(BaseModel):
    verified: list[VerifiedFactEntry] = Field(default_factory=list)
    inference: str = ""
    grounded: bool = False
