"""Ownership-enforcing data access.

The primary gate of design.md decision 5. Row Level Security is the second one; this is the first,
and it is the one that has to be right — RLS exists to catch the case where this was forgotten, not
to replace it.

Two rules the helpers make structural:

* **A caller-supplied identifier is never sufficient.** Every read and write is
  ``WHERE id = :id AND user_id = :actor``. There is no method here that takes an id without also
  taking the principal.
* **A miss is not-found, never forbidden.** A probe must not be able to distinguish "exists but is
  not yours" from "does not exist" (``specs/authentication``), so the same ``RecordNotFound`` is
  raised either way and the message says nothing about the owner.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, TypeVar

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from weathra.db.models import Base
from weathra.domain.errors import RecordNotFound
from weathra.domain.identity import Principal

__all__ = ["OwnedRepository"]

Model = TypeVar("Model", bound=Base)


class OwnedRepository:
    """Scoped access to the acting user's own rows, and to nothing else."""

    def __init__(self, session: AsyncSession, principal: Principal) -> None:
        self._session = session
        self._principal = principal

    @property
    def principal(self) -> Principal:
        return self._principal

    @property
    def session(self) -> AsyncSession:
        return self._session

    # ---------------------------------------------------------------- reads

    async def get(self, model: type[Model], record_id: str) -> Model:
        """One of the acting user's rows by id, or ``RecordNotFound``."""
        found = await self.find(model, record_id)
        if found is None:
            raise RecordNotFound(self._not_found_message(model), details={"id": record_id})
        return found

    async def find(self, model: type[Model], record_id: str) -> Model | None:
        """The same read, returning ``None`` rather than raising."""
        statement = select(model).where(
            model.__table__.c.id == record_id,
            self._ownership(model),
        )
        return (await self._session.execute(statement)).scalar_one_or_none()

    async def get_by_primary_key(self, model: type[Model]) -> Model | None:
        """A row whose primary key *is* the user id — the profile and the preference row."""
        statement = select(model).where(self._ownership(model))
        return (await self._session.execute(statement)).scalar_one_or_none()

    async def list(
        self,
        model: type[Model],
        *,
        order_by: Any | None = None,
        limit: int | None = None,
    ) -> Sequence[Model]:
        """Every row of ``model`` the acting user owns. Never anyone else's."""
        statement = select(model).where(self._ownership(model))
        if order_by is not None:
            statement = statement.order_by(order_by)
        if limit is not None:
            statement = statement.limit(limit)
        return (await self._session.execute(statement)).scalars().all()

    async def count(self, model: type[Model]) -> int:
        """How many rows of ``model`` the acting user owns — for the saved-location limit."""
        rows = await self.list(model)
        return len(rows)

    # ---------------------------------------------------------------- writes

    def add(self, instance: Model) -> Model:
        """Stage a new row, forcing its owner to be the acting user.

        The owner is *set*, not validated: a caller cannot create a row under someone else's
        ownership even by passing one, and does not get an error for trying — the field simply is
        not theirs to choose.
        """
        table = type(instance).__table__
        if "user_id" in table.c:
            instance.user_id = self._principal.user_id  # type: ignore[attr-defined]
        self._session.add(instance)
        return instance

    async def update(self, model: type[Model], record_id: str, **values: Any) -> Model:
        """Update one of the acting user's rows, or ``RecordNotFound``.

        ``user_id`` cannot be among the values: moving a row to another owner is not an operation
        this repository offers.
        """
        values.pop("user_id", None)
        if not values:
            return await self.get(model, record_id)

        statement = (
            update(model)
            .where(model.__table__.c.id == record_id, self._ownership(model))
            .values(**values)
            .returning(model.__table__.c.id)
        )
        changed = (await self._session.execute(statement)).all()
        if not changed:
            raise RecordNotFound(self._not_found_message(model), details={"id": record_id})
        await self._session.flush()
        return await self.get(model, record_id)

    async def delete(self, model: type[Model], record_id: str) -> None:
        """Delete one of the acting user's rows, or ``RecordNotFound``."""
        statement = (
            delete(model)
            .where(model.__table__.c.id == record_id, self._ownership(model))
            .returning(model.__table__.c.id)
        )
        removed = (await self._session.execute(statement)).all()
        if not removed:
            raise RecordNotFound(self._not_found_message(model), details={"id": record_id})

    async def delete_all(self, model: type[Model]) -> int:
        """Delete every row of ``model`` the acting user owns. Used by account data deletion."""
        statement = (
            delete(model).where(self._ownership(model)).returning(self._ownership_column(model))
        )
        return len((await self._session.execute(statement)).all())

    # ---------------------------------------------------------------- internals

    def _ownership_column(self, model: type[Model]) -> Any:
        table = model.__table__
        if "user_id" not in table.c:
            raise TypeError(
                f"{model.__name__} is not a user-owned table, so it must not be reached through "
                "the ownership-enforcing repository. Shared and operational tables are read "
                "directly (see design.md decision 10)."
            )
        return table.c.user_id

    def _ownership(self, model: type[Model]) -> Any:
        return self._ownership_column(model) == self._principal.user_id

    @staticmethod
    def _not_found_message(model: type[Model]) -> str:
        # Deliberately identical whether the row is absent or someone else's.
        return f"No {model.__tablename__.rstrip('s').replace('_', ' ')} with that identifier."
