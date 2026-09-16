# shop-api

Order service for the **Shop** application: orders, payment capture and order
events.

- Postgres via SQLAlchemy (`DATABASE_URL`)
- Redis cache (`REDIS_URL`)
- Stripe payments (`STRIPE_API_KEY`)
- Publishes order events to SQS (`ORDER_EVENTS_QUEUE_URL`)
- Shared logging from `common-lib`
