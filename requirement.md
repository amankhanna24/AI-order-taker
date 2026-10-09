The Order Taker
Detailed Domain Specification

Document Version: 0.1
Status: Draft
Scope: Domain, menu, ordering, modifiers, pricing, conversation context, and order-state requirements
Current Focus: Detailed product/data definition
Out of Scope for This Version: Technical architecture, vendor selection, infrastructure, deployment, UI implementation

1. Product Overview
1.1 Product Name

The Order Taker

1.2 Purpose

The Order Taker is a voice-based food ordering agent capable of having a natural conversation with a customer and converting that conversation into a structured, validated food order.

The system must understand:

Food items
Quantities
Sizes
Modifiers
Add-ons
Removals
Substitutions
Item-specific changes
Mid-order corrections
References such as "that one", "the first one", and "both"
Running totals
Order confirmation

The system must maintain a reliable structured order throughout the entire conversation.

2. Core Principle

The system must maintain a strict separation between:

Menu Data

Defines what the restaurant sells.

What can be ordered?
Order Data

Defines what the customer currently wants.

What has this customer ordered?
Conversation Data

Defines what the customer said and what the agent currently understands.

What is the customer referring to?

These three domains must not be treated as the same thing.

3. Domain Hierarchy
Restaurant
│
└── Menu
    │
    ├── Category
    │   │
    │   └── Product
    │       │
    │       └── Modifier Groups
    │           │
    │           └── Modifiers
    │
    └── Combos
        │
        └── Combo Components


Customer
│
└── Conversation
    │
    └── Order
        │
        └── Order Items
            │
            └── Order Modifiers


Order
│
├── Pricing
├── Discounts
├── Taxes
├── Fees
└── Order Events

4. Restaurant

A restaurant is the top-level business entity.

4.1 Restaurant Fields
Field	Required	Description
restaurant_id	Yes	Unique restaurant identifier
name	Yes	Restaurant name
description	No	Restaurant description
currency	Yes	Currency used for pricing
timezone	Yes	Restaurant timezone
phone	No	Restaurant phone number
status	Yes	Restaurant operational status
tax_configuration	Yes	Tax configuration
ordering_enabled	Yes	Whether ordering is currently enabled
created_at	Yes	Creation timestamp
updated_at	Yes	Last update timestamp
4.2 Restaurant Status

Possible values:

OPEN
CLOSED
TEMPORARILY_UNAVAILABLE
ORDERING_DISABLED

5. Restaurant Location

A restaurant may eventually have multiple locations.

For the initial product, location should still be represented separately.

Fields
location_id
restaurant_id
name
address
city
state
country
postal_code
phone
timezone
status


This allows the same restaurant brand to eventually have:

Green Spoon Kitchen
├── Delhi
├── Gurgaon
└── Chandigarh

6. Menu

A menu represents the products currently offered by a restaurant.

6.1 Menu Fields
menu_id
restaurant_id
name
description
status
effective_from
effective_until
created_at
updated_at

6.2 Menu Status
ACTIVE
INACTIVE
SCHEDULED
ARCHIVED

7. Category

Categories organize products.

Examples:

Veg Burgers
Pizza
Sides
Drinks
Desserts
Combos

Fields
category_id
menu_id
name
description
display_order
status

Rules
A category belongs to one menu.
A category can contain multiple products.
Products should normally belong to one primary category.
display_order controls menu presentation.
Inactive categories must not be offered by the agent.
8. Product

A product is a sellable menu item.

Examples:

Classic Veg Burger
Paneer Tikka Burger
Farmhouse Pizza
French Fries
Mango Shake
Chocolate Brownie

8.1 Product Fields
product_id
category_id
name
description
base_price
currency
status
available
vegetarian
vegan
contains_egg
ingredients
allergens
aliases
modifier_groups
tax_category
display_order

8.2 Product Status
ACTIVE
INACTIVE
ARCHIVED

8.3 Product Availability

Availability is separate from product existence.

Example:

Product exists: YES
Product available: NO


A product may become unavailable because:

It is sold out.
The kitchen temporarily disabled it.
The restaurant is unable to prepare it.
It is outside its selling hours.
9. Product Aliases

Customers do not always use official menu names.

Example:

Official:
Classic Veg Burger

Possible aliases:
- veg burger
- vegetable burger
- classic burger
- veggie burger


Aliases exist to improve product recognition.

Alias Rules

The system must not automatically select an item if an alias maps ambiguously to multiple products.

Example:

Customer:
"I want a burger."

Menu:
Classic Veg Burger
Paneer Tikka Burger
Spicy Aloo Burger


Expected behavior:

Ask clarification.


The system must not randomly select a product.

10. Ingredients

Products may contain structured ingredient information.

Example:

Classic Veg Burger

Ingredients:
- Vegetable patty
- Lettuce
- Tomato
- Onion
- House sauce
- Bun


Ingredients are useful for:

Customer questions
Modifier validation
Allergen information
Ingredient removal
Dietary filtering
11. Allergens

Allergen information must be structured and must never be invented by the language model.

Example:

Paneer Tikka Burger

Allergens:
- Milk
- Gluten


Potential allergen fields:

milk
peanuts
tree_nuts
soy
wheat
gluten
egg
sesame
mustard


If reliable information is unavailable, the agent must not guess.

Expected response:

"I don't have reliable allergen information for that item. Let me connect you with someone who can confirm."
12. Modifier

A modifier changes a product.

Examples:

Extra cheese
No onions
Add jalapenos
Large
Thin crust
Cheese burst
Extra paneer


A modifier is not itself a product.

13. Modifier Group

Modifier groups organize related modifiers.

Examples:

Size
├── Regular
├── Medium
└── Large

Cheese
├── Cheddar
├── Mozzarella
└── No Cheese

Toppings
├── Onion
├── Jalapeno
├── Mushroom
└── Extra Paneer

14. Modifier Group Fields
modifier_group_id
name
description
required
minimum_selections
maximum_selections
default_modifier_id
selection_type
status

14.1 Required Modifier Group

Example:

Pizza Size

required = true
minimum = 1
maximum = 1


The customer must select exactly one size.

14.2 Optional Modifier Group

Example:

Pizza Toppings

required = false
minimum = 0
maximum = 5


The customer may choose zero to five toppings.

15. Modifier Fields
modifier_id
modifier_group_id
name
description
price
available
status
aliases


Example:

modifier_id:
mod_extra_paneer

name:
Extra Paneer

price:
45

available:
true

16. Modifier Pricing

Modifiers may be:

FREE
PAID


Examples:

No Onion       ₹0
Ketchup        ₹0
Cheddar        ₹30
Jalapeno       ₹20
Extra Paneer   ₹45
Large          ₹30


Modifier prices must be stored separately from the base product price.

17. Product-to-Modifier Relationship

A modifier group must only be available for compatible products.

Example:

Paneer Burger
├── Size
├── Cheese
├── Toppings
└── Sauce


Pizza:

Farmhouse Pizza
├── Pizza Size
├── Crust
└── Toppings


A burger-specific modifier must not be offered for a pizza.

18. Modifier Validation

Before applying a modifier, the system must validate:

Does the modifier exist?
Is it available?
Does the product support it?
Does the modifier group allow it?
Has the maximum selection count been reached?
Is there a conflict with another modifier?
Does applying it change price?
Is it compatible with the current item state?
19. Order

An order represents the customer's current requested purchase.

19.1 Order Fields
order_id
restaurant_id
location_id
customer_id
order_type
status
items
subtotal
discount
tax
fees
total
currency
created_at
updated_at
confirmed_at
submitted_at

20. Order Types

Initial supported type:

PICKUP


Future types:

DINE_IN
DELIVERY
DRIVE_THROUGH

21. Order Status
DRAFT
IN_PROGRESS
READY_FOR_CONFIRMATION
CONFIRMED
SUBMITTED
COMPLETED
CANCELLED
FAILED

Meaning

DRAFT

Order exists but has not meaningfully started.

IN_PROGRESS

Customer is still building or modifying the order.

READYFORCONFIRMATION

Agent has reviewed the order and is waiting for confirmation.

CONFIRMED

Customer has explicitly approved the order.

SUBMITTED

Order has been sent to the restaurant/POS.

COMPLETED

Order has successfully completed the relevant workflow.

CANCELLED

Order was cancelled.

FAILED

Order submission failed.

22. Order Item

An order item represents a specific instance of a product in the customer's order.

Example:

Product:
Paneer Burger

Order Item:
line_001

Quantity:
1

Modifiers:
- Extra Paneer
- Jalapeno

Fields
line_id
order_id
product_id
product_name_snapshot
quantity
unit_base_price
modifiers
modifier_total
unit_total
line_total
position
status
created_at
updated_at

23. Product Snapshot

When an item is added to an order, important product information should be captured.

Example:

product_name_snapshot:
Paneer Tikka Burger

unit_base_price:
189


This prevents historical orders from changing if the menu price later changes.

24. Quantity

Every order item has a quantity.

Simple:

Paneer Burger × 3


However, quantities cannot always remain grouped.

Consider:

"Two paneer burgers. One with cheese and one without."

The system should create:

line_001
Paneer Burger × 1
Cheddar

line_002
Paneer Burger × 1
No Cheese


rather than:

Paneer Burger × 2
Cheese: mixed

25. Order Modifier

An order modifier represents a modifier actually selected by the customer.

Example:

Order Item:
Paneer Burger

Order Modifiers:
- Extra Paneer
- Jalapeno


The order modifier should capture the price at the time of ordering.

modifier_id
modifier_name_snapshot
modifier_price
modifier_group_id
quantity

26. Order Item Pricing

For every order item:

base product price
+
modifier prices
=
unit price


Then:

unit price × quantity
=
line total


Example:

Paneer Burger          ₹189
Extra Paneer            ₹45
Jalapeno                ₹20
--------------------------------
Unit total             ₹254

Quantity: 2

Line total             ₹508

27. Order Pricing

Order-level calculation:

Item totals
    ↓
Subtotal
    ↓
Discounts
    ↓
Taxable amount
    ↓
Tax
    ↓
Fees
    ↓
Final total


The LLM must never be the authoritative calculator.

28. Money Representation

All financial values must use a precise money representation.

Avoid unreliable floating-point calculations.

For INR, one possible representation is:

₹149
=
14900 paise


All internal calculations must use deterministic arithmetic.

29. Tax

Tax must be calculated by the pricing system.

Order should store:

subtotal
taxable_amount
tax_rate
tax_amount


Example:

Subtotal:
₹508

Tax rate:
5%

Tax:
₹25.40

30. Fees

Fees should be represented separately.

Potential fees:

service_fee
packaging_fee
delivery_fee
small_order_fee


Initial MVP can set:

fees = 0


but the data model should support them.

31. Discounts

Discounts should not be represented as arbitrary LLM-generated amounts.

A discount should come from a defined rule.

Example:

discount_id
name
type
value
eligibility
applied_amount


Potential types:

PERCENTAGE
FIXED_AMOUNT
BUY_X_GET_Y
ITEM_DISCOUNT
ORDER_DISCOUNT

32. Order Total Example
Items:

Paneer Burger × 2
₹189 × 2 = ₹378

Extra Paneer × 2
₹45 × 2 = ₹90

Jalapeno × 1
₹20

--------------------------------

Subtotal = ₹488

Discount = ₹0

Tax 5% = ₹24.40

Fees = ₹0

--------------------------------

TOTAL = ₹512.40

33. Order Modification Commands

All order changes should map to explicit operations.

Add Item
ADD_ITEM


Example:

"Add fries."
Remove Item
REMOVE_ITEM


Example:

"Remove the fries."
Change Quantity
CHANGE_QUANTITY


Example:

"Make that three."
Add Modifier
ADD_MODIFIER


Example:

"Add cheese."
Remove Modifier
REMOVE_MODIFIER


Example:

"No cheese."
Replace Modifier
REPLACE_MODIFIER


Example:

"Make that cheddar instead of mozzarella."
Replace Item
REPLACE_ITEM


Example:

"Replace the fries with garlic bread."
34. Order Event History

Every meaningful order mutation should produce an event.

Example:

ORDER_CREATED

ITEM_ADDED

MODIFIER_ADDED

QUANTITY_CHANGED

ITEM_REMOVED

MODIFIER_REMOVED

ITEM_REPLACED

ORDER_CONFIRMED

ORDER_SUBMITTED


Example history:

10:01:02
ITEM_ADDED
Paneer Burger × 2

10:01:14
ITEM_ADDED
Fries × 1

10:01:31
QUANTITY_CHANGED
Paneer Burger
2 → 3

10:01:45
MODIFIER_ADDED
Cheddar
Burger #1

10:02:01
ITEM_REMOVED
Fries

35. Why Order Events Matter

Order events provide:

Debugging
Audit history
Customer dispute resolution
Analytics
Agent quality analysis
State reconstruction
Error investigation

The final order alone is not enough.

36. Conversation

A conversation represents the interaction between customer and agent.

Fields
conversation_id
order_id
restaurant_id
session_id
state
messages
context
started_at
ended_at

37. Conversation Message

Each message should contain:

message_id
conversation_id
speaker
text
timestamp
intent
entities
confidence


Speaker values:

CUSTOMER
AGENT
SYSTEM

38. Conversation State

Initial states:

GREETING
TAKING_ORDER
CLARIFYING
ANSWERING_QUESTION
REVIEWING_ORDER
CONFIRMING_ORDER
SUBMITTING
COMPLETED
ESCALATED
CANCELLED

39. Conversation Context

Conversation context contains temporary references required to interpret the next customer statement.

Example:

last_product:
Paneer Burger

last_order_item:
line_002

last_category:
Burgers

last_action:
ADD_ITEM

current_reference:
line_002


Context is not authoritative order data.

40. Reference Resolution

Customers frequently refer to previous items indirectly.

Supported references include:

that
this
the first one
the second one
the last one
both
all
those
another one
one more
the burger
the pizza
my fries


Example:

"Two burgers."
"Make the first one large."

The system must resolve:

first one
→ line_001

41. Reference Resolution Rules

The system should consider:

Explicitly mentioned item
Current conversational subject
Most recently referenced item
Most recently added compatible item
Matching items by product/category
Clarification if ambiguity remains

The system must prefer clarification over an unsafe guess.

42. Split Items

A quantity may need to be split when modifiers differ.

Example:

"Three burgers. One without cheese and two with cheese."

Final state:

line_001
Burger × 1
No Cheese

line_002
Burger × 2
Cheddar


The system should automatically split the quantity.

43. Merging Items

Items with identical product and modifiers may be merged.

Example:

Customer:

"One veg burger."

Then:

"Add another veg burger."

Possible final representation:

Veg Burger × 2


However, merging must not destroy item-level identity when future references depend on it.

44. Mid-Order Changes

Mid-order changes are a primary requirement.

Example:

Customer:
Two paneer burgers.

System:
line_001 × 2

Customer:
Actually make that three.

System:
line_001 × 3

Customer:
One without cheese.

System:
split line

line_001 × 2
regular

line_002 × 1
no cheese


The order engine must always operate on the current state.

45. Clarification

The agent should ask a clarification question whenever the requested action cannot be safely determined.

Example:

Customer:
"I want a burger."

Menu:
Classic Veg Burger
Paneer Tikka Burger
Spicy Aloo Burger


Agent:

"Which burger would you like: Classic Veg, Paneer Tikka, or Spicy Aloo?"
46. Required vs Optional Questions

The agent should not ask unnecessary questions.

If:

Size = optional


the agent should not ask:

"What size?"

But if:

Pizza Size = required


the agent must obtain a size.

The rule is:

Required information missing
        ↓
Ask customer


Optional information:

Missing
        ↓
Use default if defined
        ↓
Otherwise continue

47. Defaults

Products may have defaults.

Example:

Classic Veg Burger

Default sauce:
House Sauce


The order representation should distinguish:

explicitly selected


from:

defaulted


This is useful if the customer later says:

"Remove the sauce."
48. Product Replacement

Replacement is different from removal + addition.

Customer:

"Replace the fries with garlic bread."

Expected semantic operation:

REPLACE_ITEM


The system should preserve relevant context where appropriate while replacing the product.

49. Modifier Replacement

Example:

"Make the cheese mozzarella instead."

Semantic operation:

REPLACE_MODIFIER


Result:

Cheddar
→
Mozzarella


This should be represented as one logical modification.

50. Availability

Availability can exist at multiple levels:

Restaurant availability
Category availability
Product availability
Modifier availability


Example:

Burger:
available

Extra Paneer:
unavailable


The customer can still order the burger, but cannot add extra paneer.

51. Time-Based Availability

Some products may have schedules.

Example:

Breakfast Menu
07:00 - 11:00


A product could contain:

available_from
available_until


The agent must not offer products outside their allowed selling window.

52. Combo

A combo is a predefined collection of products.

Example:

Veg Burger Combo

Includes:
- Classic Veg Burger
- French Fries
- Coke

Price:
₹249


A combo may also have selectable components.

Example:

Burger:
Classic / Paneer

Side:
Fries / Peri Peri Fries

Drink:
Coke / Lime Soda

53. Combo Structure
Combo
├── combo_id
├── name
├── base_price
├── components
└── rules


Each component may contain:

component_id
required
minimum_selections
maximum_selections
allowed_products

54. Combo Pricing

A combo should not simply be treated as three independent products.

Example:

Burger:
₹149

Fries:
₹99

Coke:
₹59

Individual:
₹307

Combo:
₹249


The pricing engine must understand the combo's pricing rule.

55. Dietary Attributes

Products should support structured dietary information.

Examples:

vegetarian
vegan
contains_egg
contains_dairy
gluten_free


These should be factual menu attributes.

The agent must not infer them without reliable data.

56. Customer

Customer information should be kept separate from the order.

Initial fields:

customer_id
name
phone
email


For the initial ordering flow, customer accounts can remain optional.

57. Customer Order Context

If customer identity is available, future versions may support:

previous orders
favorite items
saved preferences


This should not be required for the basic Order Taker.

58. Order Confirmation

Before submission, the system should generate a structured order summary.

Example:

Your order is:

2 Paneer Tikka Burgers
- 1 with extra paneer
- 1 without cheese

1 Peri Peri Fries

2 Cokes

Subtotal: ₹XXX
Tax: ₹XX
Total: ₹XXX

Is that correct?

59. Confirmation Rules

The order must not be submitted until confirmation is obtained when confirmation is required.

Positive examples:

yes
yeah
correct
that's right
go ahead
confirm


Negative/correction examples:

no
wait
actually
change that
remove that


A correction must reopen order editing.

60. Order Submission

Once confirmed:

Order
  ↓
Validation
  ↓
Final Pricing
  ↓
Confirmation
  ↓
Submission


Submission should only happen against a fully validated order.

61. Human Escalation

The system must support escalation.

Triggers may include:

Customer requests human
Repeated misunderstanding
Allergen uncertainty
Payment issue
POS failure
Complaint
Unusual request
Low confidence
Customer frustration


The current order and conversation context should accompany the escalation.

62. Non-Negotiable Data Integrity Rules

The following rules are fundamental.

Rule 1

The LLM is not the source of truth for menu data.

Rule 2

The LLM is not the source of truth for pricing.

Rule 3

The LLM is not the source of truth for availability.

Rule 4

The LLM must not directly modify raw order storage.

Rule 5

Every order modification must be validated.

Rule 6

Every price must come from structured pricing data.

Rule 7

Ambiguous references must result in clarification rather than guessing.

Rule 8

Products and order items must remain separate concepts.

Rule 9

Conversation state and order state must remain separate.

Rule 10

Every meaningful order mutation should be auditable.

63. Initial Vegetarian Test Menu

The initial dummy restaurant should contain enough complexity to test the ordering engine.

Burgers
Classic Veg Burger       ₹149
Paneer Tikka Burger      ₹189
Spicy Aloo Burger        ₹129

Pizza
Margherita Pizza         ₹299
Farmhouse Pizza          ₹349
Paneer Makhani Pizza     ₹399

Sides
French Fries             ₹99
Peri Peri Fries          ₹119
Cheese Garlic Bread      ₹169

Drinks
Coke                     ₹59
Fresh Lime Soda          ₹89
Mango Shake              ₹139

Desserts
Chocolate Brownie        ₹129
Vanilla Ice Cream        ₹99

64. Required Test Scenarios

The dataset must support at least the following scenarios.

Basic ordering
"I want a veg burger."

Quantity
"I want three veg burgers."

Modifier
"Add cheese."

Modifier removal
"No onions."

Multiple modifiers
"Make it large with cheese and jalapenos."

Split quantity
"Two burgers, one with cheese and one without."

Mid-order quantity change
"Actually, make that three."

Item removal
"Remove the fries."

Item replacement
"Replace the fries with garlic bread."

Modifier replacement
"Make it mozzarella instead."

Reference resolution
"Make the first one large."

Group modification
"Make both burgers spicy."

Running total
"How much am I at?"

Out of stock
"I'll have the cheesecake."

Ambiguous product
"I want a burger."

Allergen question
"Does the paneer burger contain dairy?"

Correction after confirmation review
"Wait, remove the Coke."

65. Current Domain Model

At this stage the core entities are:

Restaurant
Location
Menu
Category
Product
ModifierGroup
Modifier
Combo
ComboComponent

Customer

Order
OrderItem
OrderModifier
OrderEvent

Conversation
ConversationMessage
ConversationContext

PricingRule
Discount
TaxRule
Fee

66. What Is Intentionally Not Defined Yet

The following should be designed later:

Voice provider
Speech-to-text provider
Text-to-speech provider
LLM provider
Prompt architecture
Tool-calling implementation
Backend architecture
Database technology
Caching
API design
Authentication
POS integrations
Payment provider
Telephony provider
Deployment
Monitoring infrastructure


Those decisions should come after the domain model is stable.

67. Next Specification Phase

The next phase should go deeper into the Menu Domain.

It should define, field-by-field:

Restaurant
    ↓
Location
    ↓
Menu
    ↓
Category
    ↓
Product
    ↓
Modifier Group
    ↓
Modifier
    ↓
Combo
    ↓
Pricing Rules
    ↓
Availability Rules
    ↓
Tax Rules
    ↓
Allergen / Dietary Information


For each entity we should define:

Exact fields
Data types
Required/optional status
Allowed values
Relationships
Validation rules
Examples
Edge cases
Voice-order implications

Only after this is completely defined should we move into the Order Domain, and then the Conversation/Voice Domain.