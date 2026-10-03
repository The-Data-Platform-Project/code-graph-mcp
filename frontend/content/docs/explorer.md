The graph explorer is the visual side of ContextForge. It is at `/graph`, locally `http://127.0.0.1:3000/graph`, and needs you to sign in.

![The graph explorer showing the ContextForge repository: the sidebar with repository, search and filters on the left, the force-directed graph in the middle, and the README preview on the right.](/site/screens/explorer.png)

## Layout

| Area | What it holds |
|---|---|
| **Sidebar** (left) | Node, edge and file counts for what is on screen; the repository selector; search; node-type and edge-type filters; links to the guides; sign out |
| **Graph** (centre) | The repository as a force-directed graph, coloured by node kind |
| **Preview panel** (right) | The selected repository's README, or the selected node's source and connections |

## Choose a repository

The **Repository** list shows every indexed repository with its node count. The explorer opens on the smallest one, so the first view is legible. Choosing a repository opens its **README** in the preview panel. **Preview README** reopens it later. **All repositories** draws every repository at once.

Each repository shows at most 3,000 nodes in the explorer. The MCP tools have no such cap.

## Read the graph

Each dot is a node, coloured by kind:

| Kind | Colour |
|---|---|
| File | teal |
| Class | amber |
| Function | green |
| Method | cyan |
| Interface | violet |
| Config | grey |
| Service | red |

- **Zoom** with the scroll wheel or a pinch. Names appear once you zoom in.
- **Pan** by dragging empty space.
- **Drag a node** to pull it and its neighbours apart; it settles back when released.
- **Hover** a node to highlight it; **click** it to open it in the preview panel.

## Search and filter

**Search** keeps only nodes whose name or qualified name contains the text (not case-sensitive), and the edges between them. Type `resolve` to see everything involved in call resolution, for example.

**Node types** and **Edges** are toggles. `CONTAINS` edges (file → class → method nesting) are off by default because they dominate the picture. Turn them on to see how a file is structured, or turn `CALLS` off to see the import structure alone.

The counts at the top of the sidebar describe what is currently shown.

## Inspect a node

Clicking a node opens it in the preview panel, headed by its repository, file and line range. There are three tabs:

- **Symbol**: just this symbol's source, with line numbers. Not shown for files.
- **File**: the whole file, with this symbol's lines highlighted. Very long files are shortened, and the panel says so.
- **Connections**: everything the node is wired to.

![The Connections tab for a method, listing what calls it, what it calls, the file's imports, the files that import it, and the other symbols in the same file.](/site/screens/connections.png)

The **Connections** tab has five groups:

| Group | Shows |
|---|---|
| **Called by** | Functions and methods that call this one |
| **Calls** | What this one calls. Calls the graph could not resolve are marked *unresolved*. |
| **Imports of** *file* | The file's imports. Ones outside the repository are marked *external*. |
| **Imported by** | Indexed files that import this one |
| **Also in this file** | Other symbols defined in the same file |

Click any entry to move to that node. You can walk a call chain through the source this way without touching the canvas. Press **Esc** to close the panel.

Source is read fresh each time you open it: from your disk when self-hosted, from GitHub when hosted. The database never holds it. If a repository has no source connection, the graph still works and the panel says the source is unavailable.

## Sign out

**Sign out** at the bottom of the sidebar ends your session. Sessions otherwise last seven days.
