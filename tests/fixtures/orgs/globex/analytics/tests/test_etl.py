from analytics.etl import consume_batch, load_rows


def test_consume_batch_returns_list():
    assert isinstance(consume_batch(), list)


def test_load_rows_accepts_empty():
    assert load_rows([]) is not None
