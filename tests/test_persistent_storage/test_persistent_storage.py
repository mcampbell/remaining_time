import importlib.util
import json
import pathlib

_KV_PATH = pathlib.Path(__file__).parents[2] / "src" / "jsapi" / "_kvstore.py"
_spec = importlib.util.spec_from_file_location("_kvstore", _KV_PATH)
_kv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_kv)
KVStore = _kv.KVStore


def test_set_get_has_roundtrip(tmp_path):
    store = KVStore(str(tmp_path / "sub" / "s.json"))
    assert store.get("k") is None
    assert store.has("k") is False
    store.set("k", "v")
    assert store.get("k") == "v"
    assert store.has("k") is True


def test_persists_across_a_fresh_instance(tmp_path):
    path = str(tmp_path / "s.json")
    KVStore(path).set("estimator", "blob")
    # A new instance = an Anki restart: no shared in-memory cache.
    assert KVStore(path).get("estimator") == "blob"


def test_missing_and_corrupt_file_read_as_empty(tmp_path):
    assert KVStore(str(tmp_path / "nope.json")).get("k") is None
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    assert KVStore(str(bad)).get("k") is None


def test_purge_removes_key_and_is_a_noop_when_absent(tmp_path):
    path = str(tmp_path / "s.json")
    store = KVStore(path)
    store.set("a", 1)
    store.set("b", 2)
    store.purge("a")
    store.purge("missing")  # must not raise
    assert json.loads(pathlib.Path(path).read_text()) == {"b": 2}


def test_write_is_atomic_leaving_no_tmp_behind(tmp_path):
    path = tmp_path / "s.json"
    KVStore(str(path)).set("k", "v")
    assert path.exists()
    assert not (tmp_path / "s.json.tmp").exists()


def test_replace_all_swaps_the_whole_store_atomically(tmp_path):
    path = tmp_path / "s.json"
    store = KVStore(str(path))
    store.set("old", 1)
    store.replace_all({"a": "x", "b": "y"})
    assert store.get("old") is None
    assert KVStore(str(path)).get("a") == "x"
    assert not (tmp_path / "s.json.tmp").exists()


def test_save_retries_past_a_transient_permission_error(tmp_path, monkeypatch):
    # Windows can transiently deny os.replace() right after a file close (e.g.
    # antivirus/indexer holding a brief handle on the new .tmp file). The
    # store should retry past that instead of surfacing the whole write as a
    # crash.
    path = tmp_path / "s.json"
    store = KVStore(str(path))
    real_replace = _kv.os.replace
    calls = {"n": 0}

    def flaky_replace(src, dst):
        calls["n"] += 1
        if calls["n"] < 3:
            raise PermissionError("transient lock")
        real_replace(src, dst)

    monkeypatch.setattr(_kv.os, "replace", flaky_replace)
    monkeypatch.setattr(_kv.time, "sleep", lambda _: None)
    store.set("k", "v")

    assert calls["n"] == 3
    assert json.loads(path.read_text()) == {"k": "v"}


def test_save_gives_up_after_repeated_permission_errors(tmp_path, monkeypatch):
    path = tmp_path / "s.json"
    store = KVStore(str(path))

    def always_denied(src, dst):
        raise PermissionError("locked")

    monkeypatch.setattr(_kv.os, "replace", always_denied)
    monkeypatch.setattr(_kv.time, "sleep", lambda _: None)

    try:
        store.set("k", "v")
        raised = False
    except PermissionError:
        raised = True
    assert raised, "a persistent lock should still surface, not be swallowed silently"
