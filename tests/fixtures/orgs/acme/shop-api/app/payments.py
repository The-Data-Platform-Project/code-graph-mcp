"""Stripe payment capture."""

import os

import stripe

stripe.api_key = os.environ["STRIPE_API_KEY"]


def charge(order_id: str, amount_cents: int):
    """Capture a payment for an order and return the Stripe charge."""
    return stripe.PaymentIntent.create(
        amount=amount_cents, currency="usd", metadata={"order_id": order_id}
    )
