from ..utils.JSCallable import JSCallable

# Addon-private persistent storage: a plain in-memory dict, scoped to this
# Python module's lifetime.
#
# Anki's addon process (unlike the reviewer's webview, which fully reloads on
# every card) stays alive for the whole app session, so this still survives
# card-to-card navigation within one sitting. But it starts empty again on
# every Anki restart - by design, no stale pace estimate should carry over
# between sessions. This used to be a JSON file under user_files/ (and before
# that, mw.col.set_config), but neither is wanted now that nothing here
# should outlive the running process.
#
# ponytail: a bare dict is the whole store. No class, no tests - there is no
# behaviour here beyond what dict.get/__setitem__/pop already guarantee.
_store = {}


@JSCallable
def localStorageSetItem(key, data):
    _store[key] = data


@JSCallable
def localStorageGetItem(key):
    return _store.get(key)


@JSCallable
def localStorageHasItem(key):
    return key in _store


@JSCallable
def localStoragePurgeItem(key):
    _store.pop(key, None)
