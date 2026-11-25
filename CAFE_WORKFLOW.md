DEMO POS — Café Workflows & Edge Cases
Nov 25, 2026 · @Arch
From the owner
I've run cafés for 14 years. I started with a mall kiosk and now have two branches with about 40 seats each. Every rule in this doc exists because the thing behind it went wrong at my counter at least once.
The café this doc assumes:
• VAT-registered by default, with menu prices shown in pesos and VAT included. One store setting switches the café to non-VAT.
• 3–6 staff per shift: a cashier, 1–2 baristas, a kitchen person and a shift supervisor.
• Cash, GCash, Maya and cards, plus GrabFood and foodpanda orders on the side.
• A 7–9 AM office and school rush, then students who stay all afternoon on one drink and a laptop.
Each section gives the normal flow first, then a table of edge cases and what the POS must do about each one. My notes on Philippine discount and tax rules describe how a demo should behave. Check them with an accountant and the BIR before anyone uses this for real.
The three rules I'd tattoo on every POS developer
1.  Never let the system stop a sale during rush hour. Flag the problem and let a supervisor fix it later.
2.  Every peso that moves without a normal sale needs a name, a reason and an approver: voids, refunds, discounts, comps, drawer opens.
3.  Never delete history. Menu items, staff and prices change, but last month's receipts must still show what happened.
1. Opening the shop
Nobody sells until a business day and a shift are open, and every shift starts with a counted drawer.
1.  The supervisor logs in and opens the business day for the branch.
2.  The cashier opens a shift on one terminal and counts the starting float by denomination.
3.  The opening screen shows what needs attention today: items still marked sold out, low stock, pre-orders due today, and anything not yet synced.
4.  Staff print a test receipt and a test bar ticket.
5.  The supervisor sets the store to Open, which turns on the GrabFood and foodpanda menus.
Situation
What actually happens
What the POS must do
Float doesn't match last night's close
Closer left ₱2,000, opener counts ₱1,850
Show both counts side by side, flag the ₱150 gap, and record who counted each time
Last night's shift was never closed
Closer forgot or the tablet died
Block a new shift on that drawer until a supervisor closes the old one, marked "late close"
We stay open past midnight
Study crowd until 2 AM
Sales belong to a business date, not the calendar date. The day cutoff (e.g. 4 AM) is a setting
Two registers run at once
Weekend with two cashiers
Each terminal has its own drawer and shift. Two people never share a drawer
No coins or small bills
"Wala'y barya" at 7 AM
Count the float by denomination so a short on ₱1, ₱5 and ₱20 shows before the first sale
A pre-order pickup comes before opening
Office picks up 30 coffees at 6:30
Opening hours never block sales. "Open" only controls delivery-app menus
A price change starts today
New prices from the 1st
Show a banner on the order screen: "New prices effective today"
Internet is down at opening
Fiber is out in the area
Open the shift offline and sync later (see section 17)
Yesterday's pastries are still in the case
6 croissants left
Prompt the opener to log them as waste or move them to a "day-old" item before selling
The opener is late
Barista wants to start serving
Only roles with shift permission can open a drawer. A supervisor can open one remotely
2. Menu and item setup
A café menu isn't a price list. It's a set of items, each with sizes, temperatures, add-ons and a recipe behind it.
• Categories: Espresso, Non-coffee, Tea, Frappes, Pastries, Rice meals, Retail.
• Variants change the base price: size (12 oz / 16 oz / 22 oz) and temperature (hot / iced).
• Modifier groups hold the add-ons. Each group is required or optional and has a min and max pick. Example: "Milk: pick 1" is required, "Syrups: up to 2" is optional.
• Availability: in stock or sold out, per branch, per channel, and by time of day.
• Recipe: what each variant and modifier uses from inventory (section 10).
Situation
What actually happens
What the POS must do
An add-on costs more on bigger sizes
Oat milk is +₱30 on 12 oz but +₱40 on 16 oz
Modifier prices can be set per variant
First pump free, then paid
1 syrup pump free, ₱15 per extra pump
Modifiers support "first N free" and a quantity
"Remove" options
No whipped cream, no ice
₱0 modifiers that change the recipe, not the price
Sugar levels
0 / 25 / 50 / 75 / 100%
A required ₱0 group, printed on the cup label
Combos and sets
Breakfast set: any coffee + croissant, ₱199
Bundles with choice slots and an upcharge for premium picks (e.g. +₱40 for a Spanish latte)
One ingredient runs out
No more oat milk at 3 PM
Auto-disable every modifier that uses it. The drinks stay on sale with dairy milk
An item runs out
Last slice of cheesecake sold
One tap marks it sold out on every terminal and on the delivery apps
Time-based menus
Breakfast until 11 AM, merienda 2–5 PM
Items and promos can have time windows per day of the week
Different price per channel
Grab prices are 20% higher to cover commission
Separate price lists per channel and per branch
Price changes mid-day
Owner raises the latte price at 2 PM
Items already in a cart or open tab keep the price they had when added
Seasonal items
Christmas drinks, Nov–Dec
Start and end dates. Archive afterwards; never delete an item with sales history
Day-old pastries
50% off after 6 PM or the next morning
A time-based markdown or a separate "day-old" item that draws from the same stock
Custom or open-price item
Catering box at a negotiated price
An open item needing a name, a price and a permission. Rarely used and always logged
Retail goods
Bean bags (250 g), tumblers, gift boxes
Retail items counted in units, with optional barcodes, kept apart from drink recipes
Same drink, different recipe per branch
Branch 2 uses a different bean
The recipe is per branch while the menu item is shared
Staff and secret-menu items
Staff meal, the owner's "special"
Hidden items that only certain roles can see
3. Taking orders at the counter
The order screen has to keep up with a cashier doing 60 orders an hour. Every extra tap costs me a customer at 8 AM.
1.  Pick the order type: dine-in, takeout, or pickup for a pre-order.
2.  Add items and pick their variants and modifiers. Required choices pop up automatically.
3.  Add notes from quick chips like "less ice", "extra hot" or "allergy".
4.  Enter the customer's name for takeout or the table number for dine-in.
5.  Review the cart, take payment and send the order to the bar (pay-first is the default).
Situation
What actually happens
What the POS must do
The customer adds something after paying
"Oh, and a cookie"
Create an add-on order linked to the first one, with the same number and name, so the bar sees them together
The customer isn't ready
Still deciding, and the line is growing
Hold the cart by name, serve the next person, pick it back up later. Held carts are flagged at shift close
Three of the same drink, each a bit different
3 lattes: 1 iced, 2 hot, one with oat
Each drink is its own line. "Duplicate line" then edit, so the cashier doesn't rebuild it
Double-tap in the rush
2 lattes rung instead of 1
Large quantity display, an easy minus, and an undo for the last add
Same names
Three "Mark"s at 8 AM
Order number first, name second, and an optional last initial
Free stuff that still costs me
Hot water, a cup of ice, an extra cup
₱0 items so cups and lids still come out of inventory
Bring-your-own tumbler
₱10 off, no paper cup used
A tumbler modifier that discounts and removes the cup and lid from the recipe
Takeout turns into dine-in
"Actually, we'll stay"
Change the order type after payment. Mugs replace paper cups in the stock count
Dine-in wants a cup to go
Half-finished latte
A ₱0 or paid "to-go cup" item, set by me
Allergy note
"Nut allergy, please"
Allergy notes print in a loud style on the bar ticket and cup label, and can't be cleared silently
"How much with oat?"
Price questions slow the line
Show the live line price as modifiers are tapped, before adding
The cashier walks away
Bathroom break mid-order
Auto-lock after inactivity, keep the cart, and require a PIN to unlock
Very small shift
One person is cashier and barista
A combined mode with ordering and the queue on one screen
Rush hour
20 people in line
Fast payment buttons (exact cash, ₱100, ₱500, ₱1,000, GCash) and favourites at the top
A paid order nobody claims
Customer left without the drink
After 15 minutes it's marked "unclaimed". It stays a sale; no automatic refund
4. Dine-in, tables and open tabs
Most of my sales are pay-first at the counter, but groups, the function room and regulars run open tabs. That's where the money gets messy.
1.  Assign a table (or a table-tent number for counter orders that runners deliver).
2.  Open a tab and add rounds through the visit.
3.  Print the bill on request, take payment, and free the table.
Situation
What actually happens
What the POS must do
A group moves tables
4 people move to the sofa area
Move the tab to another table; the history stays
Two groups join
Tables 3 and 4 push together
Merge tabs, keeping who ordered what
Split the bill
Barkada of 6, everyone pays their own
Split by item, by seat, evenly, or by custom amounts. One invoice per payer
One item shared three ways
A whole cake split between 3 friends
Split a single line into fractions (⅓ each)
The bill is printed, then they order more
"One more round"
The new bill replaces the old one, which is marked superseded so nobody pays from it
Walkout
Table leaves without paying
Close as "walkout" with a supervisor PIN. It counts as a loss in reports, not a void
Campers
One drink, 5 hours, a table for 4
Show how long each table has been open. An optional minimum spend for peak hours or reserved areas
Reserved room with minimum spend
Function room, ₱5,000 consumable
Track spend against the minimum and bill the shortfall as a "consumable balance" line
Deposit for a reservation
₱1,000 paid by GCash a week before
Record the deposit as a customer credit that applies to the final bill
A tab is open at shift change
Group still seated at 3 PM
Transfer the tab to the next cashier. Both names stay on the lines they added
A tab is open at day close
Last group never billed out
The day can't close with open tabs. Transfer, bill out or close as walkout first
Two terminals edit the same tab
Cashier and runner add at the same time
Lock or merge safely so no line is lost or doubled
Service charge for big groups
10% for 10 or more
Optional and shown on its own line. In the Philippines, service charges collected must go to staff, so they stay out of sales
5. Payments
A payment isn't done when the cashier taps "Paid." It's done when the money is really in my drawer or my account.
• Cash: enter the amount tendered and the screen shows the change in big numbers.
• GCash / Maya: show the store QR, then record the reference number and amount. The order is released only after the payment shows up in the merchant app.
• Card: the standalone terminal approves it, and the cashier records the approval code and last 4 digits.
• Charge account: for approved corporate customers who are billed monthly.
Situation
What actually happens
What the POS must do
Big bill, small order, 7 AM
₱1,000 for a ₱95 coffee
Quick-tender buttons and a clear change amount. A low-change warning when the drawer's small bills run low
Odd tender to get round change
₱515 for ₱315 so the change is one ₱200 bill
Accept any tendered amount
Short by a few pesos
Customer is ₱3 short; cashier lets it go
A "small waive" with a cap (e.g. ₱5), a reason, and a per-cashier report
Fake or reused GCash screenshot
Customer shows "sent", but nothing arrived
Status stays Pending verification until confirmed. Reject a reference number that was already used
Wrong e-wallet amount
Sent ₱150 for a ₱185 order
Record a partial payment and collect the ₱35 balance by another method
Customer pays twice by e-wallet
Double-tapped in the app
Record the overpayment and refund it through the e-wallet with a supervisor PIN
Card declined
After the order is built
The order stays unpaid and the cashier switches the method. Nothing goes to the bar
Terminal approved, POS crashed
Charged, no record
On restart, find the unfinished payment and let the cashier attach the approval code. Never charge twice
Split tender
Half cash, half GCash
Several payment lines on one invoice; the order is paid when they add up to the total
Wrong method recorded
Rung as cash, really GCash
Change the method before shift close with a supervisor PIN. The expected drawer cash updates
Tips
Tip jar, or "add ₱50 tip" on GCash
Tips are recorded apart from sales and shown in a tip report for sharing among staff
Corporate account
Office next door orders daily, pays monthly
A charge-to-account tender with a credit limit, a running balance and a monthly statement
Staff charge
Barista buys lunch, deducted from pay
A staff-charge tender with a per-person limit
Foreign currency
Tourist with US dollars
Not accepted in the demo. Show a clear message
Vouchers and gift cards
Raffle gift certificate
A tender that draws down a balance (section 15)
6. Discounts and promos
Senior Citizen and PWD discounts are the law. Get them wrong and you either overcharge the customer or quietly lose money on every one.
How the Senior/PWD discount works at a VAT-registered café (computation guide):
1.  Remove the VAT first: menu price ÷ 1.12 = the VAT-exempt amount.
2.  Take 20% off the VAT-exempt amount.
3.  Apply it only to items for the ID holder's own consumption.
At a non-VAT café there's no VAT to remove, so the 20% comes straight off the menu price. The POS reads the store's VAT setting and picks the formula; the cashier never chooses.
Example
Menu price
VAT-exempt amount
20% discount
Customer pays
Senior's own iced latte, VAT-registered café
₱168
₱150
₱30
₱120
Same latte, non-VAT café
₱168
No VAT to remove
₱33.60
₱134.40
Platter shared by 4 diners, 1 senior, VAT-registered (senior's share = ₱1,120 ÷ 4)
₱280
₱250
₱50
₱200 for the share, plus ₱840 for the other three
Rules the POS has to enforce:
• One statutory discount per purchase. A senior who is also a PWD picks one.
• No stacking with promos. The customer gets whichever gives the lower price, the statutory discount or the promo.
• Shared food: if the ID holder's items can't be identified, divide the bill by the number of diners and apply the formula to each ID holder's share.
• Phone, online and family-bundle orders: the eligible portion is based on one single-serving meal with a drink (BIR RMC 71-2022).
• Records: name, ID number and signature, plus the VAT-exempt amount and discount on the invoice. The discount log at month end supports my tax claim, so it has to be complete.
Situation
What actually happens
What the POS must do
Senior buys for the grandkids too
1 senior, 3 drinks
The cashier ticks which lines belong to the ID holder. Only those get the discount
3 seniors, only 2 have IDs
"I left it at home"
Count only IDs actually presented and recorded
The same ID number again and again
Same ID entered 6 times today
Flag repeat ID numbers per day and per cashier. Often this is a cashier pocketing the difference (section 18)
Promo vs senior
Buy 1 Take 1 Tuesday plus a senior customer
Compute both, show both, apply the one with the lower final price
Minimum-spend promo breaks
₱50 off ₱500+, then an item is voided to ₱460
Re-check promo conditions on every cart change and remove the promo automatically
Buy 1 Take 1 with different items
Large latte + small mocha
Rule setting: the cheaper item is free. Recheck if one is voided
Does the promo cover add-ons?
10% student discount and an extra shot
A per-promo setting: applies to modifiers yes or no
Comps
Free drink for an influencer, an apology, or a friend
A "comp" with a reason and an approver. Stock still deducts and the cost shows in reports
Discount after the invoice is printed
"I'm a senior pala"
Not allowed on a printed invoice. Void it with approval and reissue a new one
Promo timing
Happy hour ends at 5:00, cart started at 4:58
One rule, written down: the promo is judged at the time each item is added
Rounding
20% of ₱157 gives centavos
Round each line to 2 decimals the same way every time. The invoice must add up exactly
Single-use codes
Facebook giveaway voucher "FREECOFFEE-0042"
Codes with usage limits, expiry and a log of where each was used
Employee discount
30% for staff on duty
Role-based, limited per shift, and never stacked with Senior/PWD
7. Receipts, invoices and tax records
Every completed sale gets one invoice number from an unbroken sequence. Numbers are never reused, skipped or deleted, even when a sale is voided.
What the invoice shows: store name, TIN and address, invoice number, date and time, cashier, order number, each line with its modifiers, VATable sales, VAT amount, VAT-exempt sales, discounts, payment method and change. For Senior/PWD sales it also shows the ID holder's name, ID number and a signature line. A non-VAT café's invoice drops the VAT lines and states its non-VAT status instead, following the same store setting.
A real Philippine deployment needs BIR registration of the POS and its invoice format, a non-resettable grand total and X/Z readings. Since the EOPT Act, the sales invoice is the main document for sales. DEMO POS should copy the layout and print "DEMO — NOT A VALID INVOICE" on every receipt.
Situation
What actually happens
What the POS must do
Customer asks for a reprint
Lost it, needs it for reimbursement
Same number, marked REPRINT with the reprint count. Every reprint is logged
Sale voided after printing
Wrong order, already printed
The number stays used and is marked VOID with the reason and approver
Invoice under a company name
"Pa-official receipt, sa company"
Optional buyer name, TIN and address fields, filled in before printing
Invoice requested the next day
Customer comes back with the order number
Search past sales by number, date, amount or name and reprint
Paper runs out mid-rush
Printer beeps at 8:15 AM
Queue the print, offer an e-receipt by SMS or email, and never lose the sale
Split bill
4 payers
One invoice per payer, each numbered
Senior/PWD in a group
1 senior among 5 diners
The senior's portion is shown clearly as VAT-exempt and discounted, apart from the companions' portion
Training mode
New cashier practicing
Practice sales use no invoice numbers and never show in sales reports
Offline on two terminals
Both sell during an outage
Each terminal has its own number series (e.g. T1-000123) so numbers never collide when they sync
Delivery-app orders
Grab issues its own receipt
The sale is still recorded in my POS under the Grab channel, with its own invoice if required
8. Bar and kitchen flow
A paid order splits into tickets by station: drinks to the bar, food to the kitchen. Items that need no prep, like bottled water, complete on their own. Every item moves through its own status, and the order is ready only when all its items are.
A remake sends the item back to the queue. Anything made but not sold ends as waste, so stock always matches what left the bar.
Situation
What actually happens
What the POS must do
The drink is fast, the food is slow
Latte in 3 minutes, rice meal in 12
Each item has its own status. Dine-in can be served in parts; takeout waits for the full order
Bar backlog
15 drinks queued at 8 AM
Show the wait estimate at the cashier ("about 12 min") so staff can warn customers before they pay
Same drink across many orders
6 iced Americanos in the queue
An "all-day" count per item so the barista can batch them
Priority
Grab rider waiting, pre-order due, a remake
A rush flag that moves a ticket to the top, with the reason shown
The order changes after the ticket is sent
"Make it iced instead"
The ticket updates with a clear CHANGED mark. A price difference goes back to the cashier for payment or refund
Cancelled after prep started
Customer leaves; drink is half made
The barista marks it made or not made. If made, it's logged as waste
Marked ready by mistake
Wrong ticket tapped
Undo for a short time; status changes are logged
Wrong person claims the drink
Two "Ana"s
The cup label prints the order number and name, and staff claim by number
Cup labels
20 cups look the same
Print a label per drink: item, size, temperature, modifiers, sugar level, order number
Spilled at the bar
Barista knocks over a cup
Remake from the queue. No new charge, the first one logged as waste
Ticket printer jams
Kitchen loses tickets
The screen queue is the source of truth. Reprint any ticket from it
Unclaimed after calling
Called 3 times
Move it to an "unclaimed" shelf status after a set time and keep it there until claimed or closed
9. Voids, refunds, remakes and complaints
These five words mean different things, and the POS must keep them apart in every report.
Action
When
Who can do it
Money
Stock
Line void
Before payment, before the bar starts
Cashier
None
Not deducted
Order void
After payment, nothing made yet
Supervisor PIN plus a reason
Full refund
Not deducted
Refund
After payment, item made or served
Supervisor PIN plus a reason
Full or partial
Deducted, logged as waste
Remake
Made wrong or spilled
Barista or supervisor
None
Both cups deducted, the first as waste
Comp
Free on purpose
Supervisor or owner
₱0 sale
Deducted, cost shown as comp
Reason codes are a fixed list, plus "Other" with a required note: wrong order, customer changed mind, quality complaint, long wait, foreign object, duplicate entry, payment problem.
Situation
What actually happens
What the POS must do
Partial refund
One of three drinks was wrong
Refund that line only, linked to the original invoice
Refund on a later day
Customer returns on Tuesday about Monday's cake
The refund is dated today and reduces today's cash, while still pointing to Monday's invoice
Refund by a different method
Paid by GCash, wants cash back
Default is the original method. A different one needs a supervisor PIN
Not enough cash for the refund
Drawer is low at opening
Refund from the safe as a logged paid-out, or by e-wallet
Exchange
Wrong drink, wants a different one
Swap the item, charge or refund the difference, and log the first drink as waste
"Too sweet"
Taste complaint
Remake with a reason code. Track remakes per barista and per drink to spot a recipe problem
Hair or foreign object
Serious complaint
Refund or comp, plus an incident note the owner sees that day
No supervisor on site
Night shift with only juniors
The owner approves remotely from a phone notification, or the action waits in a queue with a small cap
A supervisor approves their own void
Supervisor working the register
Flag self-approvals in the void report
Delivery-app refund
Grab customer complains
The platform handles the money. The POS logs a channel refund for the records and stock
10. Inventory and recipes
I track ingredients, not drinks. Every sale deducts its recipe, and I compare that against what's really on the shelf. The gap is where my profit leaks.
• Ingredients have a base unit (g, ml, pcs) and purchase units with conversions: a 1 kg bag of beans = 1,000 g, a case of 12 × 1 L milk = 12,000 ml.
• Recipes are set per variant: a 16 oz iced latte = 18 g beans, 200 ml milk, 1 cup, 1 lid, 1 straw.
• Modifier deltas add, remove or replace ingredients: oat milk replaces 200 ml milk with 200 ml oat, an extra shot adds 9 g of beans.
• Stock moves are a ledger: sale, receive, waste, transfer, production, count adjustment. The stock level is the sum of the ledger, never a number someone types over.
Situation
What actually happens
What the POS must do
Prepped ingredients
Cold brew: 1 kg beans + 8 L water makes about 6.5 L concentrate
Production entries turn raw ingredients into a prep item with a yield. Drinks deduct the prep item
House-made syrups and sauces
Simple syrup, caramel, whipped cream
Same as prep items, with batch dates
Dialing in the grinder
50–100 g of beans wasted every morning
A "calibration" waste reason so it doesn't look like theft
Stock goes negative
The count was wrong, but sales keep coming
Never block a sale for stock. Allow negative, alert the supervisor, and fix it at the next count
Pumps vs ml
Recipe says 2 pumps, I buy 750 ml bottles
Unit conversions per ingredient (1 pump = 10 ml)
Takeout vs dine-in
Paper cup vs ceramic mug
Packaging deducts only for takeout and delivery. A 4-cup carrier for orders of 4+ drinks
Expiry
Milk expires in 7 days
Optional batch and expiry tracking with expiry alerts, using oldest stock first
End-of-day pastries
8 croissants left at close
A quick end-of-day waste screen per item
Physical count
Weekly count on Sunday night
Blind count: the counter doesn't see expected amounts. Then a variance report in units and pesos
Counting during business hours
Sunday afternoon count
Record the count time; sales after it don't distort the variance
Branch transfers
Branch 1 lends 6 L milk to branch 2
A transfer out and a matching transfer in, both visible until received
Staff drinks and samples
Free drink per shift, tasting cups
Deduct stock under "staff meal" or "sampling" so the variance stays honest
Recipe changes
We move from 18 g to 20 g of beans
Version recipes. Old sales keep the old cost
Cost per drink
How much does a latte cost me?
Weighted average cost per ingredient, recipe cost per item, and a margin per item
11. Purchasing and suppliers
What I ordered, what arrived and what I paid are three different numbers. The POS has to keep all three.
1.  Create a purchase order for a supplier, with par levels suggesting quantities.
2.  Receive the delivery: count what arrived and enter the actual invoice price.
3.  Stock goes up and the ingredient's average cost updates.
4.  Pay the supplier, either cash from the drawer on delivery or a bank transfer on terms.
Situation
What actually happens
What the POS must do
Short delivery
Ordered 24 L of milk, received 20
Receive 20. Keep the PO open for 4 or close it short
Damaged or near-expiry goods
Dented cans, milk expiring in 2 days
Reject on receiving with a reason. The rejection counts as a supplier return
Supplier raised prices
Beans up ₱50/kg since the PO
Receive at the invoice price and alert me if a drink's margin falls below my target
Emergency grocery run
Barista buys 4 L of milk with drawer cash
A paid-out from the drawer, linked to stock received, with a photo of the receipt
Delivery without a PO
Regular supplier just drops off eggs
Allow receiving without a PO, marked for supervisor review
Supplier substitutes a brand
Different oat milk brand
Receive under the same ingredient, or map it to a new one with its own cost
Delivered before opening
Supplier arrives at 6 AM, nobody to count
Receive later with the actual arrival time noted
Paying on terms
30 days for beans
Track unpaid supplier invoices and due dates
12. Staff, roles and permissions
Everyone has their own PIN, and every sensitive action records who did it and who approved it.
Role
Can do
Can't do
Owner
Everything, across branches, including remote approvals
—
Supervisor
Open and close days, approve voids, refunds and comps, edit stock, see shift reports
Change prices or recipes, see other branches
Cashier
Take orders and payments, line voids, apply discounts within limits, hold carts
Refund, void paid orders, open the drawer without a sale
Barista / Kitchen
See the queue, mark statuses, request remakes, log waste
Take payments
Trainee
Training mode only
Real sales
Situation
What actually happens
What the POS must do
Shared logins
Everyone uses the supervisor's PIN "to save time"
Personal PINs, fast user switching, and a report of approvals by PIN
A supervisor PIN leaks
Cashiers know it
The owner can reset any PIN instantly. Approvals flag when approver and cashier are the same person
Forgot to clock out
Shift shows 19 hours
Auto-flag long shifts. The supervisor fixes the time with a reason
Buddy punching
A friend clocks you in
Clock-in only on the store's terminals, optionally with a photo
Cashier break mid-shift
Another person covers the register
The drawer belongs to one person. Covering means a quick count and handover, or a second drawer
Limits by amount
Cashier can comp up to ₱50
Thresholds per role for discounts, comps, voids and waives. Above the limit asks for a supervisor
Staff leaves the company
Resigned last week
Deactivate, never delete. Their name stays on every past sale
Staff meal allowance
One free drink per shift
A per-shift allowance tracked by person
Hours for payroll
Payroll is done in a spreadsheet
Export clock-in hours per person; payroll itself is out of scope
13. Cash management and closing
The drawer should always equal what the system expects: float + cash sales + paid-ins − cash refunds − paid-outs − cash drops. Anything else is an over or a short, and someone has to explain it.
During the shift:
• Cash drop: when the drawer goes over a limit (e.g. ₱10,000), the supervisor moves cash to the safe and both confirm the amount.
• Paid-out: cash leaves the drawer for an expense (grocery run, Lalamove fee), with a reason and a receipt photo.
• Paid-in: cash added, like extra coins for change.
• No-sale open: opening the drawer without a sale needs a reason and is always logged.
Closing:
1.  Close the shift: the cashier counts by denomination before seeing the expected amount (blind count).
2.  The POS shows expected vs counted and the over/short. Anything past the tolerance (e.g. ±₱20) needs a note.
3.  Reconcile non-cash: GCash and Maya totals against the merchant apps, card totals against the terminal's settlement report.
4.  Run the end-of-shift (X) report. At day close, run the end-of-day (Z) report for the whole branch.
5.  Record the bank deposit amount; it stays "in transit" until the deposit is confirmed.
Situation
What actually happens
What the POS must do
Recount
Cashier is ₱500 short and wants to recount
Allow one recount. Keep both counts in the log
Short and over cancel out
₱200 short on one shift, ₱200 over on the next
Report every shift separately. Never net them
Day close checklist
Something is still open
Close is blocked until there are no open tabs, held carts, pending GCash checks or open shifts
Late offline sales
A terminal syncs after the shift closed
Attach the sales to the shift where they happened and flag the report as changed after close
Card settlement differs
Bank pays next day minus fees
Track card receivables apart from cash; record fees when settled
Petty cash
Separate envelope for small expenses
Petty cash is its own fund, not the drawer
Closing after midnight
Night shift ends at 1 AM
Uses the business date from section 1
14. Delivery apps, pre-orders and bulk orders
These orders come from outside the counter, so they're the easiest to forget to record and the most likely to clash with the walk-in rush.
• Delivery apps (GrabFood, foodpanda): orders arrive on the platform tablet. For the demo, staff key them into the POS under the channel, at that channel's prices.
• Pre-orders: a scheduled pickup or delivery time, an optional deposit, and a prep reminder.
• Messenger and phone orders: taken by staff, paid by GCash or on pickup, sometimes delivered by a rider the café books.
Situation
What actually happens
What the POS must do
A Grab order is never keyed in
Busy, forgot
Daily check: platform order count vs POS channel count. Missing orders also show up as stock variance
An item is sold out but still live on the app
Customer orders the last cheesecake
Marking sold out in the POS reminds staff to turn it off on each platform too
Rider or customer cancels after prep
Food is ready, nobody comes
Log as channel cancellation plus waste. Note whether the platform will compensate
Platform pays weekly, minus commission
Payout lower than gross sales
Record channel sales as receivables. The commission % is a setting per platform, never hard-coded
30 coffees for a 9 AM meeting
Office pre-order, 50% deposit by bank transfer
Deposit recorded, the bar alerted 30 min ahead, the balance collected at pickup
A pre-order is cancelled
Meeting moved
Deposit refunded or kept according to the policy saved on the order
A bulk order hits during the rush
30 drinks land at 8:45 AM
Show bulk orders on a timeline so the supervisor can start them early or add a barista
Café-booked rider fee
Lalamove ₱90 charged to the customer
Delivery fee on its own line, apart from food sales, so it doesn't inflate sales or get discounted
Senior/PWD on a phone order
Customer declares a senior ID
Capture the ID details at ordering and check the original ID at pickup (section 6)
Catering or events
100 pax coffee station
A custom quote, deposit, charge-to-account balance and an invoice to the company
15. Customers and loyalty
Regulars keep a café alive, but loyalty points are money I owe, and I treat them that way.
• Customer profile: name and mobile number, saved only with the customer's consent (Data Privacy Act).
• Loyalty: a stamp card (buy 9, the 10th free) or points per peso spent.
• Gift cards: money paid now for drinks later. They count as a liability until used, not as sales.
Situation
What actually happens
What the POS must do
Forgot their phone
"Under Joy, 0917..."
Look up by name or the last 4 digits of the number
Two accounts for one person
Changed SIM, new number
Merge profiles while keeping all history
Points on discounted sales
Senior discount or promo applied
Earn on the amount actually paid. One rule, applied everywhere
Refund after earning
Got stamps, then a refund
Reverse the stamps or points with the refund
Redeeming a free drink
10th drink
A ₱0 sale with a reward tag. Stock deducts and the cost shows as loyalty expense
Staff adding stamps to their own number
Free drinks every week
Flag stamps added without a matching sale, and profiles that earn unusually fast
Gift card partial use
₱1,000 card, ₱185 order
Draw down and show the remaining balance on the receipt
Lost gift card
"I lost it but I have the receipt"
Look up by number or buyer. The owner can reissue the balance on a new card
Points expiry
Points from last year
An expiry rule per programme, with a warning before points expire
Customer asks to be deleted
"Remove my info"
Delete or anonymize the profile. Past sales stay, without the personal details
16. Reports and the owner's view
I check three numbers every night from my phone: net sales, cash over/short, and voids plus refunds. Everything else can wait for the weekly look.
Report
When I look
What I'm looking for
Daily summary
Every night
Gross sales, discounts, refunds, net sales, VAT, order count, average order value
Payment breakdown
Every night
Cash, GCash, Maya, card, charge account, gift card. Must match the drawer and the apps
Over/short by cashier
Every night
Who is short, how often, and by how much
Voids, refunds, comps, no-sale opens
Every night
By person, by reason, by time of day
Senior/PWD discount log
Daily check, monthly total
Each entry with ID number, items and amount; repeat IDs flagged
Best and worst sellers
Weekly
Units and pesos per item, and add-on attach rate (how often oat milk or an extra shot is added)
Sales by hour and day
Weekly
Peak hours, for scheduling baristas
Inventory variance
Weekly, after the count
Expected vs counted per ingredient, in pesos, with the biggest leaks first
Waste report
Weekly
By reason: expired, calibration, remake, spill, end of day
Food cost % and margin per item
Monthly
Recipe cost vs selling price; items whose margin dropped after supplier price changes
Channel profitability
Monthly
Delivery sales after commission vs counter sales
Branch comparison
Monthly
The same reports side by side, per branch
Labor vs sales
Monthly
Hours worked vs sales per hour
Two definitions every report must use the same way:
• Gross sales = item prices before discounts. Net sales = gross − discounts − refunds. Show net sales with and without VAT, clearly labelled, and keep service charge out of both.
• Reports group by business date, and a refund counts on the day it was given, not on the original sale date.
17. Hardware, offline mode and system failures
Brownouts and internet outages happen here. A POS that stops working when the fiber goes down will lose me a morning's sales.
Situation
What actually happens
What the POS must do
Internet goes down
Fiber outage for 3 hours
Keep selling offline from a local database. Sync when back, with no duplicates (IDs made on the device)
E-wallets while offline
No signal on the POS
Staff confirm GCash on a phone with mobile data; the POS records it as pending and verifies after sync
Brownout
Power out for 40 minutes
A UPS on the terminal and router. If everything dies: paper tickets, entered later as manual backdated sales with a flag
Tablet crashes mid-order
App closes
The cart autosaves and reopens exactly as it was
Payment sent twice by the app
Slow network, double submit
Each payment has an idempotency key, so it records once
Printer offline or jammed
Receipt or bar ticket not printed
Print jobs queue and retry. The order is never lost because a printer failed
Cash drawer won't open
Drawer cable loose
Open with the key, then log the reason
Device clock is wrong
Tablet set to the wrong date
Use server time when online; flag big differences after an offline sync
A tablet is stolen
Break-in overnight
Remote logout and disable the device; data lives on the server
Updates during service
Update pops up at 8 AM
Never update during opening hours
Backups
The server's disk fails
Daily backups, and a tested restore
18. Fraud and theft the POS must catch
Most staff are honest, but every trick below has happened at a café I know. The POS doesn't need to accuse anyone. It needs to make each trick show up in a report.
My best audit tool is the cup count: paper cups used vs takeout drinks sold. Cups don't lie.
Trick
How it works
What makes it show up
Not ringing the sale
Customer pays cash, nothing is entered, cashier keeps it
Cup and bean variance vs sales; drawer opens with no sale
No-sale drawer opens
Open the drawer to make change, slip cash out
Every open is logged with a reason; opens per cashier per shift
Void after cash payment
Ring it, take the cash, void it later
Post-payment voids need a supervisor; voids by cashier and by time
Fake senior discount
Customer pays full price; cashier adds a senior discount later and keeps the 20%
Discounts only before payment; repeat ID numbers flagged; discount rate per cashier
Under-ringing
Rings a small, serves a large to a friend
Recipe variance: beans and milk used > theoretical
Sweethearting
Free drinks for friends
Comps and remakes per staff member; cup variance
Reused GCash screenshot
Same proof shown twice
Duplicate reference numbers rejected; payments verified against the merchant app
Fake refund
Refund to yourself on an old invoice
Refunds need the original invoice and a supervisor; refunds by cashier
Stamp farming
Staff add loyalty stamps to their own number
Stamps without matching sales; profiles earning too fast
Supervisor PIN misuse
Cashier knows the PIN
Approvals logged by PIN with the terminal and time; self-approval flagged; fast PIN resets
Short deliveries
Supplier drops 20 but invoices 24
Receiving counts against the PO before signing
Buddy punching
Friend clocks you in
Clock-in on store terminals only, with an optional photo
19. Building DEMO POS (out of character)
Phase 1 alone makes a convincing demo. Phases 2 and 3 are what make it look like it was built by someone who has worked in a café.
Phase
Modules
Edge cases to show off in the demo
1 — Core sale
Business day and shifts, menu with variants and modifiers, order screen, cash and e-wallet payments, split tender, Senior/PWD discount, invoices, bar queue with statuses
Senior latte computed to ₱120, duplicate GCash reference rejected, blind drawer count with over/short
2 — Control
Roles and PINs, supervisor approvals, voids, refunds, remakes and comps with reasons, cash drops and paid-outs, X/Z reports, owner dashboard
Void-after-payment needing a PIN, the day-close checklist blocking an open tab
3 — Inventory
Ingredients, unit conversions, recipes with modifier deltas, stock ledger, receiving, waste, blind stock count, variance report
Oat milk running out disabling the modifier, the cup-count variance
4 — Extras
Tables and tabs, pre-orders and deposits, delivery channels, loyalty, gift cards, offline mode
Splitting a cake three ways, an offline sale syncing with no duplicate
Core entities
• Setup: Branch, Terminal, User, Role, Permission
• Time and cash: BusinessDay, Shift, CashCount, CashMovement (drop, paid-out, paid-in, no-sale)
• Menu: Category, Item, Variant, ModifierGroup, Modifier, ModifierPrice (per variant), PriceList (per channel), Bundle
• Orders: Order, OrderLine, OrderLineModifier, OrderStatusEvent, Table, Tab
• Money: Payment (method, reference no., status), DiscountApplication (ID holder name and ID no.), Invoice, Refund, Approval
• Stock: Ingredient, UnitConversion, Recipe, RecipeLine, ModifierRecipeDelta, StockMovement, StockCount, Supplier, PurchaseOrder, Receiving
• Customers: Customer, LoyaltyLedger, GiftCard
• Audit: AuditLog for every action that touches money or stock
Design rules that save you later
1.  Store money as integer centavos, never floats.
2.  Copy item names, prices and recipe costs onto each order line. Menu edits must never change old sales.
3.  Archive, never delete: items, staff, customers, invoices.
4.  Stock is a ledger of movements. Current stock is a sum, not a field anyone edits.
5.  Keep the business date separate from timestamps.
6.  Generate order and payment IDs on the device (UUIDs), so offline sync can't create duplicates.
7.  Record status changes as events with who and when, so every report can be rebuilt from history.
8.  Put every threshold in settings: VAT status, float amount, over/short tolerance, discount limits, cutoff time, commission %.
Sources
• How to compute PWD discounts on meals and groceries in the Philippines — the formula, group meals, the promo rule and invoice fields used in section 6