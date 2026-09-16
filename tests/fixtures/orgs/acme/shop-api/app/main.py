"""HTTP surface of the Shop API."""

from fastapi import Depends, FastAPI

from common_lib.logging import get_logger

from .cache import cached_total
from .db import get_session
from .events import publish_order_created
from .payments import charge

app = FastAPI(title="shop-api")
log = get_logger(__name__)


@app.get("/api/orders")
def list_orders(customer: str, session=Depends(get_session)):
    """List the orders belonging to one customer."""
    log.info("listing orders")
    return {"customer": customer, "orders": []}


@app.post("/api/orders")
def create_order(payload: dict, session=Depends(get_session)):
    """Create an order, capture payment and emit an event."""
    order_id = payload["id"]
    charge(order_id, payload["total"])
    publish_order_created(order_id)
    return {"id": order_id, "total": cached_total(order_id)}
