import { z } from 'zod';

export const id = z.string().regex(/^[a-z0-9]{20,40}$/, 'Invalid id');
export const idParams = z.object({ id });

export const startConversationBody = z.object({}).strict().optional();
export const messageBody = z.object({ text: z.string().min(1, 'Message is required').max(1000) }).strict();
export const confirmBody = z.object({ expectedVersion: z.number().int().min(0).max(1_000_000) }).strict();

export const availabilityBody = z.object({ available: z.boolean() }).strict();
export const restaurantBody = z
  .object({
    status: z.enum(['OPEN', 'CLOSED', 'TEMPORARILY_UNAVAILABLE']).optional(),
    orderingEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.orderingEnabled !== undefined, 'Nothing to update');

export const ordersQuery = z.object({
  status: z.enum(['DRAFT', 'IN_PROGRESS', 'READY_FOR_CONFIRMATION', 'CONFIRMED', 'SUBMITTED', 'COMPLETED', 'CANCELLED', 'FAILED']).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD').optional(),
  item: z.string().trim().min(1).max(100).optional(),
  tzOffset: z.coerce.number().int().min(-840).max(840).default(0), // minutes, as Date#getTimezoneOffset()
});

/* ---------- menu management ---------- */

const MAX_PRICE_PAISE = 10_000_000; // ₹100,000
const name = z.string().trim().min(1, 'Name is required').max(80, 'Name is too long');
const description = z.string().trim().max(300, 'Description is too long').nullable();
const price = z.number().int('Price must be a whole number of paise').min(0, 'Price cannot be negative').max(MAX_PRICE_PAISE, 'Price is too high');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm (24-hour)').nullable();
const aliases = z.array(z.string().trim().min(1).max(40)).max(10, 'At most 10 aliases');
const allergens = z.array(z.enum(['MILK', 'EGG', 'PEANUTS', 'TREE_NUTS', 'SOY', 'GLUTEN', 'SESAME', 'MUSTARD'])).max(8);

export const categoryCreateBody = z.object({ name, description: description.optional() }).strict();
export const categoryUpdateBody = z
  .object({ name: name.optional(), description: description.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const productFields = {
  name,
  description,
  basePrice: price,
  vegetarian: z.boolean(),
  vegan: z.boolean(),
  glutenFree: z.boolean(),
  allergens,
  allergenInfoVerified: z.boolean(),
  aliases,
  availableFrom: hhmm,
  availableUntil: hhmm,
};
export const productCreateBody = z
  .object({
    categoryId: id,
    name: productFields.name,
    basePrice: productFields.basePrice,
    description: productFields.description.optional(),
    vegetarian: productFields.vegetarian.optional(),
    vegan: productFields.vegan.optional(),
    glutenFree: productFields.glutenFree.optional(),
    allergens: productFields.allergens.optional(),
    allergenInfoVerified: productFields.allergenInfoVerified.optional(),
    aliases: productFields.aliases.optional(),
    availableFrom: productFields.availableFrom.optional(),
    availableUntil: productFields.availableUntil.optional(),
  })
  .strict();
export const productUpdateBody = z
  .object({ categoryId: id, available: z.boolean(), ...productFields })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const modifierCreateBody = z.object({ name, priceDelta: price }).strict();
export const modifierUpdateBody = z
  .object({ name: name.optional(), priceDelta: price.optional(), available: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const comboUpdateBody = z
  .object({ name: name.optional(), description: description.optional(), basePrice: price.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const orderStatusBody =z.object({ status: z.enum(['COMPLETED', 'FAILED', 'SUBMITTED']) }).strict();
