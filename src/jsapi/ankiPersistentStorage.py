import os

from aqt import mw

from ..utils.JSCallable import JSCallable
from ._kvstore import KVStore

# Addon-private persistent storage, kept in a plain JSON file under the addon's
# user_files/ dir (which Anki preserves across addon updates).
#
# Deliberately NOT mw.col.set_config: that marks the collection modified, and
# the addon writes on every reviewed card, so AnkiWeb sync never showed a clean
# state. The data kept here (the pace estimate and last-seen card counts) is
# per-device working state and does not need to sync.
_STORAGE_PATH = os.path.join(
    os.path.dirname(__file__), "..", "user_files", "persistent_storage.json"
)

# Old backend: a single collection-config entry. Read once to migrate, never
# written back (so it does not re-dirty the collection).
_LEGACY_CONFIG_KEY = "remainingTimeStorage"

_store = KVStore(_STORAGE_PATH)
_migrated = False


def _ensureMigrated():
    global _migrated
    if _migrated:
        return
    _migrated = True
    if os.path.exists(_STORAGE_PATH):
        return
    try:
        legacy = mw.col.get_config(_LEGACY_CONFIG_KEY, None)
    except Exception:
        return
    if isinstance(legacy, dict) and legacy:
        _store.replace_all(legacy)


@JSCallable
def localStorageSetItem(key, data):
    _ensureMigrated()
    _store.set(key, data)


@JSCallable
def localStorageGetItem(key):
    _ensureMigrated()
    return _store.get(key)


@JSCallable
def localStorageHasItem(key):
    _ensureMigrated()
    return _store.has(key)


@JSCallable
def localStoragePurgeItem(key):
    _ensureMigrated()
    _store.purge(key)
