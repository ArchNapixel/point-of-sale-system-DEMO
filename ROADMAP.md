# DEMO POS — Roadmap

Derived from section 19 of [CAFE_WORKFLOW.md](CAFE_WORKFLOW.md). Phase 1 alone is a convincing demo; Phases 2–3 make it feel built by someone who has worked in a café.

**How we work:** one part at a time. Each part ends in something you can open and try, with a test for any money/tax/stock logic. Check items off as they ship; don't start the next part until the current one is approved. Every part is labelled like `1C` (phase 1, part C).

## Phase 0 — Foundations ✅
- [x] Choose stack and record it in [CLAUDE.md](CLAUDE.md)
- [x] Project scaffold and test runner (no seed data; data is entered by hand)
- [x] Core entities: Branch, Terminal, User, Role, Permission, Settings
- [x] Money as integer centavos; device UUIDs; AuditLog helper; DEMO receipt footer

## Phase 1 — Core sale

### 1A — Setup and sign-in
Because there is no seed data, you need screens to enter it.
- [x] App shell and navigation (tablet-friendly)
- [x] Add/edit branch, terminal (with invoice prefix like `T1`) and users with a role and PIN
- [x] Settings screen (VAT on/off, float, tolerance, cutoff hour)
- [x] PIN sign-in and sign-out (first run creates the owner)
- [x] Hide screens a role can't use (Setup and Settings are owner-only; add new screens to the tab list in App.tsx)

### 1B — Business day and shift open
- [x] Open the business day for the branch (supervisor)
- [x] Open a shift on a terminal; count the float by denomination
- [x] Flag a gap against last close; block a new shift while the prior one is unclosed
- [x] Nobody can sell without an open day and shift (`getSellContext`, used by the order screen in 1E)

### 1C — Menu: categories, items, variants
- [x] Categories and items, archive instead of delete
- [x] Variants (size, hot/iced) that set the price
- [x] Sold-out toggle

### 1D — Menu: modifiers
- [x] Modifier groups (required, min/max pick)
- [x] Modifier prices per variant, "first N free", ₱0 modifiers (no ice, sugar level)

### 1E — Order screen (cart)
- [x] Order type: dine-in, takeout, pickup
- [x] Add items; required modifier prompts; live line price
- [x] Note chips, duplicate line, easy minus, undo last add
- [x] Customer name or table, hold a cart and pick it back up; order number counter built (`nextOrderNumber`), the number is given at payment in 1F
- [x] Prices copied onto each order line

### 1F — Cash payment (first complete sale)
- [ ] Cash tendered, change shown large, quick buttons (exact, ₱100, ₱500, ₱1,000)
- [ ] Save a paid order and show it on a simple order list
- [ ] Order stays unpaid until payment lines add up to the total

### 1G — Other payments
- [ ] GCash/Maya: reference number, Pending verification, duplicate reference rejected
- [ ] Card: approval code and last 4 digits
- [ ] Split tender and partial payment

### 1H — Senior/PWD discount
- [ ] VAT-aware formula picked by the store setting
- [ ] Tick which lines belong to the ID holder; capture name and ID number
- [ ] One statutory discount, lower-price-wins against promos
- [ ] Discount log with repeat-ID flag

### 1I — Invoices
- [ ] Unbroken per-terminal number series
- [ ] VATable, VAT-exempt and discount lines; non-VAT variant
- [ ] Printable receipt with the DEMO footer; buyer name/TIN
- [ ] Reprint marked REPRINT and logged; search past sales

### 1J — Bar queue
- [ ] Tickets split by station, per-item status
- [ ] Wait estimate at the cashier, rush flag
- [ ] Cup labels; allergy notes in loud style

### 1K — Shift close
- [ ] Blind drawer count by denomination
- [ ] Expected vs counted, over/short, note past tolerance
- [ ] One recount, both counts logged

**Demo moments:** senior latte → ₱120 · duplicate GCash reference rejected · blind count with over/short

## Phase 2 — Control

### 2A — Approvals and limits
- [ ] Supervisor PIN prompt; approvals logged by PIN, terminal and time
- [ ] Self-approval flagged; per-role limits

### 2B — Voids, refunds, remakes, comps
- [ ] Line void, order void, refund (partial/later-day/other method), remake, comp
- [ ] Fixed reason codes plus "Other" with a note

### 2C — Cash movements
- [ ] Cash drops, paid-outs, paid-ins, no-sale opens (reason, logged)
- [ ] Expected drawer cash includes them

### 2D — Promos
- [ ] Time windows, min-spend recheck, B1T1, single-use codes, employee discount

### 2E — Day close and reports
- [ ] Day-close checklist (blocks on open tabs, held carts, pending GCash, open shifts)
- [ ] X / Z reports
- [ ] Owner dashboard: net sales, over/short, voids/refunds/comps/no-sales, senior/PWD log, payment breakdown

### 2F — Staff extras
- [ ] Fast user switch, auto-lock, PIN reset by owner
- [ ] Clock-in/out hours export

**Demo moments:** void-after-payment needing a PIN · day close blocked by an open tab

## Phase 3 — Inventory

### 3A — Ingredients and units
- [ ] Ingredients, base units, conversions (pump→ml, kg→g)

### 3B — Recipes
- [ ] Recipes per variant; modifier deltas (add/remove/replace); takeout-only packaging

### 3C — Stock ledger and waste
- [ ] Ledger (sale, receive, waste, transfer, production, count adjustment); negative stock allowed + alert
- [ ] Waste screen with reason codes
- [ ] Auto-disable modifiers when an ingredient runs out

### 3D — Purchasing
- [ ] Suppliers, purchase orders, receiving (short/rejected/no-PO), weighted average cost

### 3E — Counts and variance
- [ ] Blind stock count; variance report in units and pesos
- [ ] Cup-count variance; cost per drink and margin

**Demo moments:** oat milk runs out → modifier disabled · cup-count variance flags a missing sale

## Phase 4 — Extras

### 4A — Tables and tabs
- [ ] Tables, open tabs, move/merge, transfer at shift change
- [ ] Split bill (item/seat/even/custom/fraction), superseded bills, walkout

### 4B — Pre-orders and delivery
- [ ] Pre-orders with deposits, bulk-order timeline
- [ ] Delivery channels with per-channel prices and commission %

### 4C — Customers and loyalty
- [ ] Customers (consent), stamps/points with reversal on refund, gift cards
- [ ] Data-privacy delete/anonymize

### 4D — Offline and sync
- [ ] Outbox sync to the Hono API + Neon, idempotent, no duplicates
- [ ] Per-terminal series across sync, late-sync flagging, print queue with retry

### 4E — Misc
- [ ] Training mode, service charge, tips report, charge accounts

**Demo moments:** cake split three ways · offline sale syncs with no duplicate

## Out of scope
Payroll, real BIR registration/accreditation, foreign currency, live delivery-app integrations (orders are keyed in by staff).
