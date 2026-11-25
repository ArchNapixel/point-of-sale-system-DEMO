# DEMO POS — Project Guide

A demo point-of-sale system for a Philippine café (2 branches, ~40 seats each, 3–6 staff per shift). Source of truth for behaviour: [CAFE_WORKFLOW.md](CAFE_WORKFLOW.md). Build order: [ROADMAP.md](ROADMAP.md).

Status: no code yet. Stack is chosen (below); Phase 0 scaffolds it.

## Stack
Web-based, offline-first PWA (a website opened in Chrome; no install needed).
- **Frontend:** React + TypeScript + Vite, with a service worker so the app loads offline. Dev: `npm run dev`. Test offline with `npm run build && npm run preview` (service worker only runs in a production build).
- **Local DB:** IndexedDB via Dexie. Every sale is written locally first.
- **Sync:** outbox queue. Device-made UUIDs + idempotency keys; the server ignores duplicates. No sync framework unless live multi-terminal updates are needed.
- **Backend:** small Node API (Hono) in front of **Neon** Postgres. Not Supabase. PINs and roles are handled in our own API.
- **Hosting:** static frontend (Vercel/Netlify/Cloudflare Pages) over HTTPS; API and Neon separate.
- **Printing:** browser print first; ESC/POS and cash drawer later via Web Serial/WebUSB (Chrome only).
- **Targets:** Chrome on Android/Windows tablets (iOS Safari can evict stored data). Staff open the site once per shift so the cached copy is loaded.
- **No seed data:** the owner enters all data by hand.

## Product rules (never violate)
1. **Never block a sale during rush.** Flag problems (negative stock, unverified GCash, etc.) for a supervisor; don't stop the cashier.
2. **Every peso that moves without a normal sale needs a name, a reason and an approver**: voids, refunds, discounts, comps, drawer opens, paid-outs.
3. **Never delete history.** Archive/deactivate items, staff, customers, invoices.

## Design rules
1. Money = integer centavos. No floats.
2. Copy item name, price and recipe cost onto each order line; menu edits never change old sales.
3. Stock is a ledger of movements; current stock is a sum, never an editable field.
4. Business date is separate from timestamps (day cutoff, e.g. 4 AM, is a setting).
5. Order/payment IDs are UUIDs made on the device; payments carry an idempotency key.
6. Status changes are events (who, when); reports are rebuildable from history.
7. Every threshold lives in settings: VAT on/off, float, over/short tolerance, discount limits, cutoff time, platform commission %, waive cap.
8. Every action touching money or stock writes an AuditLog entry.
9. Invoice numbers: unbroken per-terminal series (e.g. `T1-000123`), never reused/skipped/deleted; voids keep their number. Every receipt prints `DEMO — NOT A VALID INVOICE`.

## Domain essentials
- **VAT**: store setting. VAT-registered: prices are VAT-inclusive. Non-VAT: invoice drops VAT lines.
- **Senior/PWD discount** (cashier never picks the formula; the store VAT setting does): VAT-registered → `price ÷ 1.12`, then 20% off that. Non-VAT → 20% off price. Only the ID holder's own items; one statutory discount per purchase; no stacking with promos (customer gets the lower price); round each line to 2 decimals consistently; not allowed after invoice print (void + reissue). Record name, ID no., signature, VAT-exempt amount, discount. Worked examples: ₱168 latte → ₱120 (VAT) / ₱134.40 (non-VAT).
- **Void vs refund vs remake vs comp**: distinct actions with distinct money/stock effects (table in section 9 of the workflow doc); keep them separate in every report.
- **Service charge, tips, delivery fees** are never part of sales or discounts.
- **Gross sales** = prices before discounts. **Net sales** = gross − discounts − refunds. Reports group by business date; refunds count on the day given.
- **Roles**: Owner, Supervisor, Cashier, Barista/Kitchen, Trainee (training mode: no invoice numbers, excluded from reports). Personal PINs; flag self-approval.
- Tax/discount notes describe demo behaviour only — must be checked with an accountant/BIR before real use.

## Conventions
- When the workflow doc and the code disagree, the doc wins unless the user says otherwise; update the doc if behaviour changes.
- Prefer the simplest implementation that satisfies a roadmap item; no speculative abstractions.
- Each money/tax/stock computation gets at least one runnable test (e.g. senior latte = ₱120, duplicate GCash ref rejected, drawer over/short).
- Do not `git push`; the user pushes. Commit locally only when asked.
- When a task is finished, always end the reply with a suggested commit message (e.g. `Add cash payment and order list (1F)`), matching the style of recent commits. Suggest only; don't commit unless asked.
