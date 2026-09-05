# UI guidelines

The screen is read by a tired operator in a dark room at 3 a.m. Everything below follows
from that.

## Principles

- **Incidents, not cameras.** Nobody watches sixteen tiles. The default screen is a
  ranked queue of work; the camera grid is a separate section.
- **Never lie about capability.** A dead stream must not look like a quiet night. Hence
  `LiveDot`, `CameraStatusPill`, `SimulatedBadge`, `NotWired`. An empty honest screen
  beats a plausible fake one.
- **Always show why.** Every alert carries its evidence — zone, path, box, named rule
  (`EvidenceOverlay`). An alert nobody can explain gets ignored.

## Building a screen

Wrap it in `<PageShell title description actions toolbar>`. No screen invents its own
header.

Handle all four states — a screen missing one is unfinished:

| State | Use |
|---|---|
| loading | `<LoadingRows />` |
| error | `<ErrorState error onRetry />` |
| empty | `<NothingHere icon title description />` |
| role-locked | `<RoleGate need="supervisor">` |

## Components

`components/ui/` is shadcn (new-york, neutral) — add with `bunx shadcn@latest add <x>`,
don't hand-write primitives. `components/ibvap/` is ours: badges, page shell, states,
sector map, evidence overlay, reason dialog.

## Colour and type

Use semantic tokens (`bg-background`, `text-muted-foreground`, `border-border`). Raw
colour is allowed in exactly two places, both fixed scales already defined in
`components/ibvap/badges.tsx`: severity (INFO / WARNING / CRITICAL) and camera status
(FULL → DEAD). Don't invent a third.

IBM Plex Sans for text, Plex Mono for ids, times, counts and rules. Numbers in a scanned
column get `font-mono tabular-nums`.

Both themes must work. The map inverts its tiles in dark mode — a control room at 3 a.m.
should not be lit by a white map.

## Interaction

- Keyboard first on the incident queue: `↑↓`/`j k` move, `⏎` open, `A` ack, `E` escalate,
  `D` dismiss. Never steal a key from someone typing in an input.
- Escalate and dismiss open `<ReasonDialog>` — the node rejects them with a 422 without a
  reason, so the dialog is the screen agreeing with the database.
- Sheet for detail, dialog for a decision.
- A section the role can't use is shown **locked with a tooltip**, not hidden. The
  platform is the same everywhere; a nav bar that changes shape per person is worse.
