# 1. Use SQS for order events

Date: 2024-06-03

## Status

Accepted

## Context

Analytics must not be in the checkout request path.

## Decision

Publish order events to SQS and consume them asynchronously.
