# Trace panel — layout spec

The hero UI. Designed before it is built, because the video's first 20 seconds is this panel reacting.

## Hero frame (video 0:00–0:20)

Two columns, 60/40. Left: the call transcript. Right: the trace panel, full height.

The frame the video opens on:

```
┌─────────────────────────────────┬──────────────────────────────────────┐
│  Rosewood Family Practice       │  POLICY TRACE            ⬤ DENIED   │
│  incoming call · 00:41          │  ──────────────────────────────────  │
│                                 │  patient.ssn                         │
│  ▸ "and can you read me back    │  SENSITIVE_PII                       │
│    the social on file?"         │                                      │
│                                 │  RULE_NEVER_BY_PHONE                 │
│  ◂ "I don't have access to      │  Full SSN. Never disclosable by      │
│    that field."                 │  phone under any verification.       │
│                                 │                                      │
│                                 │  LINEAGE                             │
│                                 │  patient.ssn            SENSITIVE_PII│
│                                 │    └─ derive ─▸ billing.ssn_last4  ⬆ │
│                                 │        └─ derive ─▸ claim.sub_key   ⬆ │
│                                 │                                      │
│                                 │  decided in 41µs                     │
│  ─────────────────────────────  ├──────────────────────────────────────┤
│  blocked reads    ▎7            │  cost/call $0 · p95 41µs · arm64     │
└─────────────────────────────────┴──────────────────────────────────────┘
```

The refusal sentence is `type.size.hero` (38px) in the transcript. It is the largest text on screen — a judge scrubbing without audio still reads it.

## Deny vs allow

Same shape, different weight. A denial is not an error, so it is not a toast:

| | DENY | ALLOW |
|---|---|---|
| Verdict chip | `color.deny` fill, `shadow.denySeal` | `color.allow`, no glow |
| Panel edge | 2px left border `color.deny` | 1px `color.border` |
| Background | `color.denySurface` | `color.surfaceRaised` |
| Rationale | shown always | shown on hover only |
| Entry motion | `motion.base` fade + 4px rise | `motion.fast` fade |

An allowed read is unremarkable and must not compete for attention. Restraint here is what makes the denial land.

## Lineage chain at depth 3+

Vertical indent, one hop per row, deepest last. Each row: source field (mono, 14px), transform verb (13px, `textTertiary`), target field, and the inherited tier chip.

The **inherited hop is the point** — where restriction propagated into a column the operator classified loosely. That row gets `color.lineageInherited` on its connector and an ⬆ marker, with the tooltip: *"inherited SENSITIVE_PII from patient.ssn — operator classified this OPERATIONAL."*

At depth > 4, collapse the middle with `··· 2 more hops` and keep the first and last visible. Never scroll the chain during the demo.

## Blocked-reads counter

Bottom-left, pinned. Value in `type.size.display` (30px) mono, tabular numerals so the digit doesn't reflow on increment. Label above in `micro` + `tracking.wide` uppercase.

On increment: value scales 1.0 → 1.06 → 1.0 over `motion.base`, and a 3px `color.deny` bar wipes left-to-right beneath it. Perceptible, never bouncy — a HIPAA denial is not a game score.

Placement is deliberate: bottom-left is where the eye lands after reading the refusal top-right, and it survives the 1080p downscale at 30px.

## Compression notes

- No pure black — `#0F1419` avoids banding in dark gradients on YouTube.
- Tier chips carry a text label, never colour alone; colour-only encoding dies under compression and fails accessibility.
- 15px floor for all body text. The lineage rows are the smallest at 14px mono, which holds because mono glyphs survive downscaling better than sans at equal size.
- Nothing important within 48px of frame edge — YouTube's player chrome overlays the bottom on hover.
