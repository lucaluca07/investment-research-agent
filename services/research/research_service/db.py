from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from threading import RLock

import duckdb


class Database:
    """Owns one DuckDB connection for the lifetime of a service process."""

    def __init__(self, path: str = ":memory:") -> None:
        self.connection = duckdb.connect(path)
        self._transaction_lock = RLock()
        schema = Path(__file__).with_name("schema.sql").read_text()
        self.connection.execute(schema)

    @contextmanager
    def transaction(self) -> Iterator[duckdb.DuckDBPyConnection]:
        with self._transaction_lock:
            self.connection.execute("BEGIN TRANSACTION")
            try:
                yield self.connection
            except Exception:
                self.connection.execute("ROLLBACK")
                raise
            else:
                self.connection.execute("COMMIT")

    def close(self) -> None:
        self.connection.close()
