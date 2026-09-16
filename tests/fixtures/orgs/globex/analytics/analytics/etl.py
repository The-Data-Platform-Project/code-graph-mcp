"""Order-events ETL: SQS to BigQuery."""

import json
import os

import boto3
from google.cloud import bigquery

from common_lib.logging import get_logger
from common_lib.retry import with_retry

log = get_logger(__name__)
sqs = boto3.client("sqs")
QUEUE_URL = os.environ["ORDER_EVENTS_QUEUE_URL"]
DATASET = os.getenv("BQ_DATASET", "globex_analytics")


def consume_batch():
    """Read one batch of order events from the queue."""
    response = sqs.receive_message(QueueUrl=QUEUE_URL, MaxNumberOfMessages=10)
    return [json.loads(m["Body"]) for m in response.get("Messages", [])]


def load_rows(rows):
    """Insert rows into the BigQuery orders table."""
    client = bigquery.Client()
    return client.insert_rows_json(f"{DATASET}.orders", rows)


def run():
    """Consume a batch and load it, retrying transient failures."""
    rows = with_retry(consume_batch)
    log.info("loading rows", count=len(rows))
    return load_rows(rows)
