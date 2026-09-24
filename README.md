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
5. The algorithm demo replays how the solver actually grew the paths on this exact
   board, one step at a time.
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

## Development

```bash
npm install
npm run dev      # dev server
npm run build    # type-check and build to dist/
npm test         # solver unit tests
```

`python/` holds a command-line version managed by [uv](https://docs.astral.sh/uv/),
kept as a cross-language reference for the same algorithms:

```bash
cd python && uv run python demo.py <screenshot>
```

Pushing to `main` builds and publishes the site through GitHub Actions.
