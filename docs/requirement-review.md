# Requirement Review & Amendments (v0.1 → v0.2)

Review of `requirement.md`. Section numbers refer to the original. Each item lists the problem and the **adopted correction** that the implementation follows.

## A. Outright errors / typos

| # | Section | Problem | Correction |
|---|---|---|---|
| 1 | §21 | `READYFORCONFIRMATION` (missing underscores) | `READY_FOR_CONFIRMATION` |
| 2 | §24, §17, §22, §26, §32, §44 | "Paneer Burger" is used everywhere but the menu (§63) only has **Paneer Tikka Burger** | Use "Paneer Tikka Burger"; alias "paneer burger" maps to it |
| 3 | §52 | Combo drink "Lime Soda" ≠ menu item "Fresh Lime Soda" | Use "Fresh Lime Soda" |
| 4 | §32 | Example puts a burger-level modifier on only "1" of 2 burgers inside a single ×2 line, contradicting §24 (one line = identical items) | Re-expressed as two lines: `Tikka ×1 + Extra Paneer + Jalapeno` and `Tikka ×1 + Extra Paneer` — totals unchanged (₹488 / tax ₹24.40 / ₹512.40) |
| 5 | §60 | Flow `Validation → Final Pricing → Confirmation → Submission` follows "Once confirmed", i.e. confirmation appears twice/out of order | `Validate → Price → Summarise → Customer confirms → Re-validate + Re-price → Submit` (the order can change between summary and "yes") |
| 6 | §3 | Hierarchy shows `Customer → Conversation → Order`, but §56 says customers are optional | Conversation/Order exist without a customer; `customer_id` is nullable |
| 7 | §7 | "Combos" listed as a Category, but §3/§52 model Combo as a separate entity | Combos are a separate entity, surfaced in the menu as a virtual "Combos" section |

## B. Contradictions between sections

| # | Sections | Problem | Correction |
|---|---|---|---|
| 8 | §4.1/§4.2 | `ORDERING_DISABLED` status duplicates `ordering_enabled` | Status = `OPEN \| CLOSED \| TEMPORARILY_UNAVAILABLE`; `ordering_enabled` is the sole kill-switch |
| 9 | §8.1 vs §11 vs §55 | Product has `contains_egg`; allergens use `egg`; §55 adds `contains_dairy`, `gluten_free`; allergen list says `milk`; `wheat` and `gluten` overlap | One canonical allergen enum: `MILK, EGG, PEANUTS, TREE_NUTS, SOY, GLUTEN, SESAME, MUSTARD` (wheat ⊂ gluten). Dietary flags `vegetarian/vegan/contains_egg/contains_dairy/gluten_free` are **derived** from allergens + explicit flags, never free-typed. Synonyms ("dairy" → MILK, "wheat" → GLUTEN) live in a lookup |
| 10 | §11 | An empty allergen list cannot distinguish "no allergens" from "unknown" — yet the agent must not guess | Add `allergen_info_verified: boolean`. Only `true` permits an answer; otherwise escalate message |
| 11 | §8.1 vs §51 | Time-window fields exist in prose but not in the Product field list | Add `available_from`, `available_until` (restaurant-local `HH:mm`, nullable) |
| 12 | §8.1 vs §4.1 | `currency` on Product duplicates Restaurant currency (risk of mismatch) | Removed from Product; single currency on Restaurant |
| 13 | §14 | `required` duplicates `minimum_selections` (`required ⇔ min ≥ 1`) and could disagree; `selection_type` values undefined | `required` is derived; `selection_type ∈ {SINGLE, MULTIPLE}`; validation `min ≤ max`, `SINGLE ⇒ max = 1` |
| 14 | §12/§16 vs §10 | "No onions" modelled as a ₹0 modifier *and* as ingredient removal | Ingredients have `removable`. A removal request on a removable ingredient creates an order modifier of kind `REMOVAL` (₹0) referencing the ingredient — no fake modifier rows needed |
| 15 | §15/§16 | `FREE/PAID` is described but there is no field; "Large ₹30" is ambiguous (absolute price vs delta) | `price_delta` in paise (≥ 0); FREE ⇔ 0. Size prices are **deltas** over base |
| 16 | §25 vs §26 | OrderModifier has `quantity` but the pricing formula ignores it | `unit_total = base + Σ(modifier_price × modifier_quantity)` |
| 17 | §47 | Requires distinguishing explicit vs defaulted selections but OrderModifier has no field | Add `source ∈ {EXPLICIT, DEFAULT}` |
| 18 | §43 vs §40 | "Merging identical lines" conflicts with "first one"/"second one" references | Never merge stored lines automatically; merge only in the *summary display*. Explicit "add another" creates a new line (or increments if the customer says "make that three") |
| 19 | §29 vs §8.1 | Order stores a single `tax_rate` but products have a `tax_category` (possibly different rates) | Tax is computed per tax category; order stores a `tax_breakdown` JSON plus total `tax`. MVP has one category (5%) |
| 20 | §29 | Rounding and inclusive/exclusive tax not defined | Tax-**exclusive**, computed on `taxable_amount` (post-discount), rounded **half-up to the paisa** per category |
| 21 | §36 vs §65 | Conversation embeds `messages`/`context` yet ConversationMessage/ConversationContext are separate entities | `ConversationMessage` is a table; `context` is a JSON column typed as `ConversationContext` |
| 22 | §38 vs §21 | No mapping between conversation state and order status | Added: `REVIEWING_ORDER ↔ READY_FOR_CONFIRMATION`, `CONFIRMING_ORDER ↔ CONFIRMED`, `SUBMITTING ↔ SUBMITTED`; any edit during review returns order to `IN_PROGRESS` |
| 23 | §5 vs §6 | Order has `location_id` but Menu belongs only to Restaurant | Menu gets nullable `location_id` (null = all locations) |

## C. Missing definitions

| # | Section | Gap | Addition |
|---|---|---|---|
| 24 | §21 | No transition table. `DRAFT` vs `IN_PROGRESS` and `COMPLETED` are vague | `DRAFT`: no items yet. `IN_PROGRESS`: ≥1 item. `COMPLETED`: restaurant marked picked-up/fulfilled. Allowed: DRAFT→IN_PROGRESS→READY_FOR_CONFIRMATION→CONFIRMED→SUBMITTED→COMPLETED; READY/CONFIRMED→IN_PROGRESS (correction); SUBMITTED→FAILED→SUBMITTED (retry); any non-terminal→CANCELLED. Terminal: COMPLETED, CANCELLED |
| 25 | §19/§20 | PICKUP order has no customer contact or pickup time | Order gets `customer_name`, `customer_phone` (required before confirmation), `pickup_at` (optional), `notes` |
| 26 | §19 | No concurrency/idempotency fields | `version` (optimistic lock), `idempotency_key` (unique) on submission |
| 27 | §19/§29 | Order lacks `taxable_amount` / `tax_breakdown` that §29 says to store | Added |
| 28 | §18 | Validation list omits required-group completeness, quantity limits | Added: all required groups satisfied at confirmation; line quantity 1–50; max 100 units per order; modifier quantity 1–10 |
| 29 | §33 | Command list is incomplete | Added `SPLIT_ITEM`, `CLEAR_ORDER`/`CANCEL_ORDER`, `SET_CUSTOMER_DETAILS`, `ADD_COMBO`, `REQUEST_CONFIRMATION`, `CONFIRM_ORDER`, and read-only `GET_SUMMARY` |
| 30 | §34 | Event list lacks events for operations the spec itself defines | Added `ITEM_SPLIT`, `MODIFIER_REPLACED` (§49 requires one logical change), `ORDER_CANCELLED`, `ORDER_FAILED`, `ORDER_REOPENED`, `ESCALATED`, `CUSTOMER_DETAILS_SET` |
| 31 | §65 | Entity list omits join/support entities | Added `ProductModifierGroup` (ordering + overrides), `ComboComponentProduct`, `OrderDiscount`, `OrderFee`, `Escalation` |
| 32 | §54 | Combo pricing rule undefined | `combo.base_price` is the fixed price; components may carry an `upcharge`; modifiers on components priced normally |
| 33 | §59 | "actually" listed as a negative reply, but it also starts a correction | Classification is by the engine: affirmative only counts if the message has no edit intent. "yes" + edit → edit wins |

## D. Test-menu / scenario gaps (§63 vs §64)

| # | Problem | Fix |
|---|---|---|
| 34 | "Cheesecake" (out-of-stock scenario) not on menu | Seeded as **Classic Cheesecake**, `available = false` |
| 35 | "Make it large", "cheese", "jalapenos", "mozzarella/cheddar", "no onions" need modifiers that §63 never defines | Seeded: Burger *Size* (Regular/Medium/Large +₹30), *Cheese* (None/Cheddar +₹30/Mozzarella +₹30), *Toppings* (Jalapeno ₹20, Mushroom ₹25, Extra Paneer ₹45), *Spice Level* (Mild/Spicy ₹0), *Sauce* (default House Sauce); Pizza *Size* (required) / *Crust* / *Toppings* |
| 36 | "Make both burgers spicy" collides with product "Spicy Aloo Burger" | "spicy" resolves to the *Spice Level* modifier when a line is the referent; the product name needs "aloo" |
| 37 | "Fries" matches both French Fries and Peri Peri Fries, yet §33/§48 treat it as unambiguous | Per §9 this must trigger clarification; examples updated to "French Fries" |
| 38 | "Replace fries with garlic bread" — product is "Cheese Garlic Bread" | Alias "garlic bread" |
| 39 | "Add cheese" is ambiguous (Cheddar vs Mozzarella) | Clarify unless a group default exists (none for Cheese) |
| 40 | Allergen scenario asks about "dairy"; data says milk | Synonym map (item 9) |
| 41 | Combo (§52) not in test menu | Seed "Veg Burger Combo" ₹249 (Burger choice / Side choice / Drink choice) |
| 42 | Mango Shake / Brownie / Ice Cream / Paneer items need allergen data to be useful | Seeded with `allergen_info_verified = true` for all but one deliberate unverified item (Chocolate Brownie) to test the escalation path |

## E. Scope reconciliation

- The spec's header says UI, architecture and vendor selection are out of scope, but the task is to build the feature. Decisions taken: **Express + TypeScript + Prisma + PostgreSQL**, **React + Vite** frontend, **Google Gemini** (free tier) via function-calling as the language layer.
- "Voice-based" (§1.2) but providers are undefined (§66). v1 delivers a **text chat with browser speech input/output** (Web Speech API, progressive enhancement); the engine is channel-agnostic so telephony can plug in later.
- When the Gemini key is absent or the quota is exhausted, a deterministic fallback parser handles the core commands so the product still works and is testable.
- The LLM never touches storage (§62 Rules 1-4): it only emits tool calls; the order engine validates, prices and persists them.
- Authentication (§66): customers are anonymous and access their conversation via an unguessable session token; menu/admin endpoints require an `ADMIN_API_KEY`.
