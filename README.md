# Catego

An **argument-mapping canvas** for Obsidian. Where core Canvas gives you boxes
and lines, Catego gives every box a *role* and every line a *meaning* — so a
board is not a picture of an argument but the argument itself, laid out so you
can check it.

Boards are ordinary files in your vault (`.catego`), like Excalidraw drawings.
No account, no server. Desktop only.

## What you can express

**Nodes carry a role** — thesis, premise, assumption, belief, fact, conclusion,
objection, response, definition, axiom, postulate, question, source, scope.
A node can also be negated (¬), carry a probability, and an epistemic status:
*accepted*, *challenged*, *disputed*, *unsolvable*.

**Arrows carry a relation**, in two groups:

| Math logic | Reality |
| --- | --- |
| AND, OR, XOR | therefore (→), because (←), but, in order to |
| implies (⇒), equivalently (⇔) | supports, contradicts, presupposes |
| | necessary / sufficient condition for |
| | refines, generalizes, is example of, counter-example of |
| | analogous to, identical |
| | increases / decreases the probability (weighted) |

AND / OR / identical fold into n-ary groups, and an arrow can attach to another
arrow's operator pill, so compound statements stay one object.

Also: regions (grouping, lockable), figures, text labels, freehand pen,
Markdown and LaTeX (KaTeX) inside nodes.

## Any file as a node

Drag a file from the file explorer onto a board, right-click it →
**Add as Catego node**, or run the command **Add this file as a node in the
open board**. Works for notes, PDFs, images, audio, other boards — anything in the
vault. The node shows the file name; its link button opens the file in a new
tab. Renaming the file renames the node, and vice versa.

## Keyboard-first

Every toolbar button and every type in the properties panel shows its hotkey.
The essentials:

| Keys | Action |
| --- | --- |
| `N` | new node |
| `Enter` | toggle command / edit mode (type into the selected node) |
| `Tab` / `.` | tap: next node / next arrow |
| `W` `A` `S` `D` | move the selected node |
| `Cmd` + `WASD` | jump to the nearest **node** in that direction |
| `.` + `WASD` | jump to the nearest **arrow** in that direction |
| `Option` + `WASD` | resize |
| `I` `J` `K` `L` | pull an arrow out of the selected node |
| `Shift` + letter | set the node / arrow type |
| `Shift` + `1`…`0` | color |
| `` ` `` | properties panel |
| `?` | full cheat-sheet |

Directional jumps start from whatever is selected, so `Cmd` and `.` move freely
between nodes and arrows.

## Export

**Print whole board** renders the entire board at full scale to a lossless PNG —
text stays crisp however far out you are zoomed. JPEG / PDF export the current
viewport.

## File format

A `.catego` file has two parts:

```
n1 : premise "Socrates is a man" @200,100
n2 : conclusion "Socrates is mortal" #accepted @320,300
n1 -> n2 : supports

%%catego:extras
{"version":2,"notes":{…},"full":{…}}
```

- The **DSL block** on top is a readable projection of the logic — good for
  diffs, search, and for handing a board to an AI.
- The **`full` snapshot** in the extras block is the lossless source of truth
  the plugin loads: it also holds what the DSL grammar does not express (pen
  strokes, text labels, arrow curves and colors, fonts, file links).

Boards can also be created from text: the DSL import dialog parses the grammar
above and lays the graph out automatically.

## Privacy

The plugin makes **no network requests** and collects **no telemetry**.
Everything stays in your vault.

## Development

```bash
npm install
npm run build     # production build → main.js, styles.css
npm run dev       # watching build
```

This plugin shares its canvas, logic model and DSL with the Catego web app.
`src/shared/` is vendored from that project by its release script, so please
send changes to those files upstream.

## License

MIT
