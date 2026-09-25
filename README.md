# Linkr 求解器

A solver for [Linkr](https://www.playlinkr.net/), the daily linking game.

Drop in a screenshot — it reads the board, works out the answer, and draws it.

## Online

<https://le0.me/linkr/>

## Usage

1. Drag a screenshot into the page, or open one with the file button.
2. The detected board is drawn over the image: rings are the points, lines are the
   connections, and matching coloured pairs are the endpoints to join.
3. If the detection is off, fix it with the editing tools — add a point, delete a
   point or an edge, link two points, or set a colour.
4. Press solve. Tick the uniqueness option to also check, by exhausting the search,
   that no second answer exists.
5. The algorithm demo replays how the solver grew the paths on this exact board, one
   step at a time. When the search found the answer it is the real derivation; when
   SAT did, it is a replay of the answer, because SAT never walks a path.
6. Export the answer as an image (cropped to the board) or as JSON.

## How it solves

Every colour starts from its endpoint at once, and each step extends whichever head
currently has the fewest options — it is the one that runs out of room first, so a
dead end surfaces while every path is still short.

Four checks run after every step:

- a path may never pass through another colour's endpoint, or that endpoint ends up
  with the wrong number of connections
- an unused point must still have enough free connections left to be traversable
- every head must still be able to reach its own endpoint
- a leftover region with neither a head nor an endpoint in it is dead

When a board fails, it is retried with the colours renumbered. The shape of the
search tree depends almost entirely on the order of the colours — not on the vertex
numbering, and not on the order moves are tried.

### The SAT engine

The search above runs out on some boards: a 64-point triangle lattice goes past two
million nodes without finishing. So there is also a SAT engine, and the two are
scheduled rather than one always winning:

- **Solving** asks for a growth order the demo can replay. A SAT answer has none —
  the solver decides variables, it does not walk paths — so the search gets a bounded
  first shot (1.2 s). Boards it finishes keep a genuine derivation; boards it does
  not are handed to SAT, and the demo says the replay is a replay.
- **The uniqueness check** asks no such question, so it always runs on SAT, which is
  what turns it from a 20-second exhaustion into a proof.

The encoding has two variable families — `x[w][c]` for "point `w` carries colour `c`"
and `y[j]` for "edge `j` is used" — instead of one variable per (edge, colour) pair.
Putting the degree cap on `y` alone keeps it at `C(d, 3)` clauses per point rather
than `C(k·d, 3)`; a real board is about 1.1k variables and 8.3k clauses instead of
1.2M. Degree plus colour agreement already force every colour's subgraph to be paths
and pure cycles, so the only thing left is to rule out a cycle, done by solving again
with a cut for each one found. Real boards need none.

The solver is [batsat](https://crates.io/crates/batsat) in `sat/`, compiled to
WebAssembly. It has no imports, so it is carried in the bundle as base64 and works on
a `file://` page too. The same board that defeats the search solves in about 9 ms.

SAT also answers the uniqueness question exactly: the `y` variables *are* the edge
set, so forbidding one assignment and re-solving proves there is no second answer —
no need to compare paths by hand.

## Development

```bash
npm install
npm run dev      # dev server
npm run build    # type-check and build to dist/
npm test         # solver, vision and SAT unit tests
```

Everything above needs only Node. Regenerating the SAT engine is the one thing that
needs Rust — the built wasm is committed as `src/sat.wasm.ts`, so nobody else has to:

```bash
rustup target add wasm32-unknown-unknown
npm run sat:build   # sat/ -> src/sat.wasm.ts
```

`python/` holds a command-line version managed by [uv](https://docs.astral.sh/uv/),
kept as a cross-language reference for the same algorithms:

```bash
cd python && uv run python demo.py <screenshot>
```

Pushing to `main` builds and publishes the site through GitHub Actions.
