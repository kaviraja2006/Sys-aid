from app.core.history import trim_history, build_summary_prefix, WINDOW_SIZE, SUMMARY_EVERY, MAX_MSG_CHARS


def test_trim_history_empty():
    assert trim_history(None) == []
    assert trim_history([]) == []


def test_trim_history_strips_metadata_and_keeps_role_text():
    history = [{"role": "user", "text": "hi", "id": "abc", "timestamp": 123}]
    assert trim_history(history) == [{"role": "user", "text": "hi"}]


def test_trim_history_keeps_only_last_window():
    history = [{"role": "user", "text": str(i)} for i in range(WINDOW_SIZE + 5)]
    trimmed = trim_history(history)
    assert len(trimmed) == WINDOW_SIZE
    assert trimmed[-1]["text"] == str(WINDOW_SIZE + 4)


def test_trim_history_truncates_long_messages():
    long_text = "x" * (MAX_MSG_CHARS + 100)
    trimmed = trim_history([{"role": "user", "text": long_text}])
    assert len(trimmed[0]["text"]) == MAX_MSG_CHARS + len(" …[truncated]")
    assert trimmed[0]["text"].endswith("…[truncated]")


def test_trim_history_falls_back_to_content_key():
    trimmed = trim_history([{"role": "ai", "content": "from content field"}])
    assert trimmed == [{"role": "ai", "text": "from content field"}]


def test_build_summary_prefix_none_when_short():
    history = [{"role": "user", "text": str(i)} for i in range(SUMMARY_EVERY)]
    assert build_summary_prefix(history) is None


def test_build_summary_prefix_returns_summary_when_long():
    history = [{"role": "user", "text": f"msg{i}"} for i in range(SUMMARY_EVERY + 5)]
    summary = build_summary_prefix(history)
    assert summary is not None
    assert summary["role"] == "system"
    assert "msg0" in summary["content"]
    # Most recent WINDOW_SIZE messages should not be part of the summarized "older" section
    assert f"msg{SUMMARY_EVERY + 4}" not in summary["content"]
