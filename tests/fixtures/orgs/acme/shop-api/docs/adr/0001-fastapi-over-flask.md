# 1. Use FastAPI rather than Flask

Date: 2024-02-11

## Status

Accepted

## Context

The order endpoints need request validation and generated OpenAPI documentation.

## Decision

Use FastAPI. The generated schema is published as `openapi.yaml`.

## Consequences

Handlers are typed; the storefront can generate its client from the schema.
