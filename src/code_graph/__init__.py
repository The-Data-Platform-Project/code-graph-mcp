"""code-graph-mcp: a persistent, queryable code knowledge graph served over MCP.

Parses source repositories with tree-sitter into a SQLite graph of functions,
classes, methods, imports and call chains, and exposes structural queries
("what calls X", "what does this file depend on") as MCP tools.
"""

__version__ = "1.0.0"
