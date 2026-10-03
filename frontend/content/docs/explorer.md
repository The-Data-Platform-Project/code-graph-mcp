The graph explorer is the visual side of ContextForge. It lives at `/graph` (locally `http://127.0.0.1:3000/graph`) and needs you to sign in.

![The graph explorer showing the ContextForge repository: the sidebar with repository, search and filters on the left, the force-directed graph in the middle, and the README preview on the right.](/site/screens/explorer.png)

## Layout

| Area | What it holds |
|---|---|
| Sidebar (left) | Node, edge and file counts for what's on screen; the repository selector; search; node-type and edge-type filters; links to the guides; sign out |
| Graph (centre) | The repository drawn as a force-directed graph, coloured by node kind |
| Preview panel (right) | The selected repository's README, or the selected node's source and connections |

## Choose a repository

The Repository list shows every indexed repository with its node count. The explorer opens on the smallest one so the first view is readable. Picking a repository opens its README in the preview panel, and Preview README brings it back later. All repositories draws every repository at once.

Each repository shows at most 3,000 nodes in the explorer. The MCP tools don't have that cap.

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

Scroll or pinch to zoom, and names start appearing once you're zoomed in. Drag empty space to pan. You can also drag a node to pull it and its neighbours apart, and it settles back when you let go. Hovering a node highlights it, and clicking it opens it in the preview panel.

## Search and filter

Search keeps only the nodes whose name or qualified name contains your text (it isn't case-sensitive), plus the edges between them. Typing `resolve`, for example, shows everything involved in call resolution.

Node types and Edges are toggles. `CONTAINS` edges (file to class to method nesting) are off by default because they take over the picture. Turn them on to see how a file is structured, or turn `CALLS` off to see just the import structure.

The counts at the top of the sidebar always describe what's currently on screen.

## Inspect a node

Clicking a node opens it in the preview panel, headed by its repository, file and line range. The Symbol tab shows just that symbol's source with line numbers (files don't get this tab). The File tab shows the whole file with the symbol's lines highlighted, and very long files are shortened with a note saying so. The Connections tab shows everything the node is wired to.

![The Connections tab for a method, listing what calls it, what it calls, the file's imports, the files that import it, and the other symbols in the same file.](/site/screens/connections.png)

Connections is split into five groups:

| Group | Shows |
|---|---|
| Called by | Functions and methods that call this one |
| Calls | What this one calls. Calls the graph couldn't resolve are marked *unresolved*. |
| Imports of *file* | The file's imports. Ones outside the repository are marked *external*. |
| Imported by | Indexed files that import this one |
| Also in this file | Other symbols defined in the same file |

Click any entry to jump to that node. That way you can walk a whole call chain through the source without touching the canvas. Press Esc to close the panel.

Source is read fresh every time you open it, from your disk when self-hosted and from GitHub when hosted, and the database never holds it. If a repository has no source connection, the graph still works and the panel just says the source isn't available.

## Sign out

Sign out is at the bottom of the sidebar. Otherwise sessions last seven days.
