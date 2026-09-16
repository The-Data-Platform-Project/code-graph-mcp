# broken

Deliberately hostile inputs: an unparseable Python file, an unsupported
language, and (generated at build time) an oversized file. Indexing must skip
them individually and still index `ok.py`.
