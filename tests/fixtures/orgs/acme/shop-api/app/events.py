"""Order event publishing."""

import json
import os

import boto3

sqs = boto3.client("sqs")
QUEUE_URL = os.environ["ORDER_EVENTS_QUEUE_URL"]


def publish_order_created(order_id: str):
    """Publish an order-created event for downstream analytics."""
    return sqs.send_message(QueueUrl=QUEUE_URL, MessageBody=json.dumps({"order": order_id}))
