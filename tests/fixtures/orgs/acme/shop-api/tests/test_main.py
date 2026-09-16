from app.main import create_order, list_orders


def test_list_orders_returns_customer():
    assert list_orders("c1", session=None)["customer"] == "c1"


def test_create_order_returns_id():
    assert create_order({"id": "o1", "total": 100}, session=None)["id"] == "o1"
