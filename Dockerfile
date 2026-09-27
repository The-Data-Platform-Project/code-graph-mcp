# glibc slim base: tree-sitter + grammar wheels install cleanly, no toolchain
# needed (all deps ship manylinux/abi3 wheels), so the image stays lean.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8765 \
    WORKSPACES_ROOT=/workspaces \
    VISUALIZER_DIR=/app/visualizer

WORKDIR /app

# Dependencies first (their own cached layer). Exact pinned versions => the
# runtime never fetches anything.
COPY requirements.lock.txt ./
RUN pip install --no-cache-dir -r requirements.lock.txt

# Then the application. --no-deps: everything is already pinned above.
COPY pyproject.toml README.md LICENSE ./
COPY src ./src
# The graph UI, served at `/` by the same process that serves /mcp.
COPY visualizer ./visualizer
RUN pip install --no-cache-dir --no-deps .

# Run unprivileged. The graph lives in Postgres, so the container needs no
# writable state of its own beyond /tmp.
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 8765

# Liveness: can we open the MCP port? Pure-stdlib, no extra tooling, loopback
# only — never an outbound call.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import socket,sys; s=socket.socket(); s.settimeout(2); sys.exit(0 if s.connect_ex(('127.0.0.1',8765))==0 else 1)"

CMD ["python", "-m", "code_graph"]
