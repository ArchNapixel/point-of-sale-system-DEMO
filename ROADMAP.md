# DEMO POS — Roadmap

Derived from section 19 of [CAFE_WORKFLOW.md](CAFE_WORKFLOW.md). Phase 1 alone is a convincing demo; Phases 2–3 make it feel built by someone who has worked in a café. Check items off as they ship.

## Phase 0 — Foundations
- [x] Choose stack (offline-capable local DB + sync, tablet UI, printing) and record it in [CLAUDE.md](CLAUDE.md)
- [x] Project scaffold and test runner (no seed data; data is entered by hand)
- [x] Core entities: Branch, Terminal, User, Role, Permission, Settings (VAT, float, tolerance, cutoff, limits)
- [x] Money as integer centavos; UUID generation on device; AuditLog helper; "DEMO — NOT A VALID INVOICE" receipt footer

## Phase 1 — Core sale
- [ ] BusinessDay + Shift: open day, open shift with float counted by denomination, float mismatch flag, block on unclosed prior shift
- [ ] Menu: categories, items, variants (size/temp), modifier groups (required/min/max), per-variant modifier prices, ₱0 modifiers, sold-out toggle
- [ ] Order screen: dine-in/takeout/pickup, live line price, notes chips, duplicate line, undo last add, hold cart, order number + name
- [ ] Payments: cash (tendered/change, quick buttons), GCash/Maya (reference no., Pending verification, duplicate ref rejected), card (approval code), split tender, partial payment
- [ ] Senior/PWD discount: VAT-aware formula, per-line ID-holder selection, one statutory discount, no promo stacking, ID log, repeat-ID flag
- [ ] Invoices: unbroken per-terminal series, VATable/VAT-exempt/discount lines, reprint marked REPRINT + logged, buyer name/TIN, search past sales
- [ ] Bar queue: tickets by station, per-item status, wait estimate, rush flag, cup labels, allergy styling
- [ ] Shift close: blind drawer count, expected vs counted, over/short, one recount

**Demo moments:** senior latte → ₱120 · duplicate GCash reference rejected · blind count with over/short

## Phase 2 — Control
- [ ] Roles, personal PINs, fast user switch, per-role thresholds, auto-lock
- [ ] Supervisor approvals; self-approval flagged; owner remote approval queue
- [ ] Line void, order void, refund (partial/later-day/other method), remake, comp — each with fixed reason codes
- [ ] Cash drops, paid-outs, paid-ins, no-sale opens (reason, logged)
- [ ] Day-close checklist (blocks on open tabs, held carts, pending GCash, open shifts)
- [ ] X / Z reports; owner dashboard (net sales, over/short, voids+refunds+comps+no-sales, senior/PWD log, payment breakdown)
- [ ] Promos: time windows, min-spend recheck, B1T1, single-use codes, employee discount

**Demo moments:** void-after-payment needing a PIN · day close blocked by an open tab

## Phase 3 — Inventory
- [ ] Ingredients, base units, unit conversions (pump→ml, kg→g)
- [ ] Recipes per variant + modifier deltas (add/remove/replace); takeout-only packaging
- [ ] Stock ledger (sale, receive, waste, transfer, production, count adjustment); negative stock allowed + alert
- [ ] Auto-disable modifiers when an ingredient runs out
- [ ] Waste screen with reason codes (calibration, expired, remake, spill, end-of-day)
- [ ] Suppliers, purchase orders, receiving (short/rejected/no-PO), weighted average cost
- [ ] Blind stock count + variance report (units and pesos); cup-count variance; cost per drink and margin

**Demo moments:** oat milk runs out → modifier disabled · cup-count variance flags a missing sale

## Phase 4 — Extras
- [ ] Tables and tabs: move, merge, split (item/seat/even/custom/fraction), superseded bills, walkout, transfer at shift change
- [ ] Pre-orders + deposits, bulk-order timeline, delivery channels with per-channel prices and commission %
- [ ] Customers + loyalty (stamps/points, reversal on refund), gift cards, data-privacy delete/anonymize
- [ ] Offline mode: local DB, per-terminal invoice series, idempotent sync, late-sync flagging, print queue with retry
- [ ] Training mode; service charge; tips report; charge accounts

**Demo moments:** cake split three ways · offline sale syncs with no duplicate

## Out of scope
Payroll, real BIR registration/accreditation, foreign currency, live delivery-app integrations (orders are keyed in by staff).
