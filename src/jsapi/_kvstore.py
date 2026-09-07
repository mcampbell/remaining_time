"""Tiny file-backed key/value store: a JSON dict on disk, cached in memory.

Deliberately free of any `aqt` import so the logic stays unit-testable on its
own. `ankiPersistentStorage.py` is the thin Anki-facing wrapper.
"""

import json
import os
import time


class KVStore:
    def __init__(self, path):
        self._path = path
        self._cache = None

    def _load(self):
        if self._cache is None:
            try:
                with open(self._path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self._cache = data if isinstance(data, dict) else {}
            except (OSError, ValueError):
                # Missing or corrupt file - start empty rather than crash.
                self._cache = {}
        return self._cache

    def _save(self):
        directory = os.path.dirname(self._path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        tmp = self._path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._cache, f)
        self._replace(tmp)

    def _replace(self, tmp):
        # os.replace() is atomic, so a crash mid-write can't corrupt the file.
        # On Windows it can also raise PermissionError for a moment right
        # after close(), e.g. antivirus or the search indexer briefly holding
        # the new .tmp file open. Retry past that transient lock instead of
        # surfacing every write as a crash.
        attempts = 5
        delay = 0.05
        for attempt in range(attempts):
            try:
                os.replace(tmp, self._path)
                return
            except PermissionError:
                if attempt == attempts - 1:
                    raise
                time.sleep(delay)

    def get(self, key):
        return self._load().get(key, None)

    def has(self, key):
        return key in self._load()

    def set(self, key, value):
        self._load()[key] = value
        self._save()

    def replace_all(self, mapping):
        """Swap the whole store in one atomic write (used for migration)."""
        self._cache = dict(mapping)
        self._save()

    def purge(self, key):
        store = self._load()
        if key in store:
            del store[key]
            self._save()
