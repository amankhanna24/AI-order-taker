import { Router, type NextFunction, type Request, type Response } from 'express';
import { env } from '../config/env';
import { formatMoney } from '../domain/money';
import { adminAuthFailLimiter, adminLimiter, bearerToken, messageLimiter, requireAdmin, startLimiter } from '../middleware/security';
import * as admin from '../services/adminService';
import { getRestaurantBySlug, loadCatalog } from '../services/catalog';
import * as conv from '../services/conversationService';
import {
  availabilityBody,
  categoryCreateBody,
  categoryUpdateBody,
  comboUpdateBody,
  confirmBody,
  idParams,
  messageBody,
  modifierCreateBody,
  modifierUpdateBody,
  orderStatusBody,
  ordersQuery,
  productCreateBody,
  productUpdateBody,
  restaurantBody,
} from '../validators/schemas';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};
const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });

export const router = Router();

/* ---------- public ---------- */

router.get(
  '/menu',
  wrap(async (_req, res) => {
    const r = await getRestaurantBySlug(env.DEFAULT_RESTAURANT_SLUG);
    const c = await loadCatalog(r.id);
    const cur = c.restaurant.currency;
    const categories = [...new Set(c.products.map((p) => p.category))].map((name) => ({
      name,
      products: c.products
        .filter((p) => p.category === name)
        .map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          price: p.basePrice,
          priceDisplay: formatMoney(p.basePrice, cur),
          available: p.orderable.ok,
          unavailableReason: p.orderable.ok ? null : (p.orderable as { reason: string }).reason,
          vegetarian: p.vegetarian,
          vegan: p.vegan,
          allergens: p.allergenInfoVerified ? p.allergens : null,
        })),
    }));
    ok(res, {
      restaurant: { name: c.restaurant.name, currency: cur, status: c.restaurant.status, orderingEnabled: c.restaurant.orderingEnabled },
      categories,
      combos: c.combos.map((x) => ({
        id: x.id,
        name: x.name,
        description: x.description,
        price: x.basePrice,
        priceDisplay: formatMoney(x.basePrice, cur),
        available: x.orderable.ok,
      })),
    });
  }),
);

router.post(
  '/conversations',
  startLimiter,
  wrap(async (_req, res) => {
    ok(res, await conv.startConversation(env.DEFAULT_RESTAURANT_SLUG), 201);
  }),
);

router.get(
  '/conversations/:id',
  wrap(async (req, res) => {
    const { id } = idParams.parse(req.params);
    ok(res, await conv.getConversation(id, bearerToken(req)));
  }),
);

router.post(
  '/conversations/:id/messages',
  messageLimiter,
  wrap(async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { text } = messageBody.parse(req.body);
    ok(res, await conv.handleMessage(id, bearerToken(req), text));
  }),
);

router.post(
  '/conversations/:id/confirm',
  messageLimiter,
  wrap(async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { expectedVersion } = confirmBody.parse(req.body);
    ok(res, await conv.confirmFromUi(id, bearerToken(req), expectedVersion));
  }),
);

router.post(
  '/conversations/:id/cancel',
  messageLimiter,
  wrap(async (req, res) => {
    const { id } = idParams.parse(req.params);
    ok(res, await conv.cancelFromUi(id, bearerToken(req)));
  }),
);

/* ---------- admin (x-admin-key header) ---------- */

export const adminRouter = Router();
adminRouter.use(adminAuthFailLimiter, adminLimiter, requireAdmin);
const restaurantId = async () => (await getRestaurantBySlug(env.DEFAULT_RESTAURANT_SLUG)).id;

/** Lets the staff console check a key before it unlocks anything: 200 only for the correct key (requireAdmin rejects the rest). */
adminRouter.get('/session', (_req, res) => ok(res, { valid: true }));

adminRouter.get('/menu', wrap(async (_req, res) => ok(res, await admin.adminMenu(await restaurantId()))));
adminRouter.patch('/restaurant', wrap(async (req, res) => ok(res, await admin.updateRestaurant(await restaurantId(), restaurantBody.parse(req.body)))));
adminRouter.patch(
  '/products/:id/availability',
  wrap(async (req, res) => {
    const { id } = idParams.parse(req.params);
    ok(res, await admin.setProductAvailability(await restaurantId(), id, availabilityBody.parse(req.body).available));
  }),
);
adminRouter.patch(
  '/modifiers/:id/availability',
  wrap(async (req, res) => {
    const { id } = idParams.parse(req.params);
    ok(res, await admin.setModifierAvailability(await restaurantId(), id, availabilityBody.parse(req.body).available));
  }),
);
adminRouter.patch(
  '/combos/:id/availability',
  wrap(async (req, res) => {
    const { id } = idParams.parse(req.params);
    ok(res, await admin.setComboAvailability(await restaurantId(), id, availabilityBody.parse(req.body).available));
  }),
);
const byId = (fn: (rid: string, id: string, body: unknown) => Promise<unknown>, schema?: { parse: (v: unknown) => unknown }, status = 200) =>
  wrap(async (req, res) => {
    const { id } = idParams.parse(req.params);
    ok(res, await fn(await restaurantId(), id, schema ? schema.parse(req.body) : undefined), status);
  });

adminRouter.post('/categories', wrap(async (req, res) => ok(res, await admin.createCategory(await restaurantId(), categoryCreateBody.parse(req.body)), 201)));
adminRouter.patch('/categories/:id', byId((r, id, b) => admin.updateCategory(r, id, b as never), categoryUpdateBody));
adminRouter.delete('/categories/:id', byId((r, id) => admin.deleteCategory(r, id)));
adminRouter.post('/products', wrap(async (req, res) => ok(res, await admin.createProduct(await restaurantId(), productCreateBody.parse(req.body)), 201)));
adminRouter.patch('/products/:id', byId((r, id, b) => admin.updateProduct(r, id, b as never), productUpdateBody));
adminRouter.delete('/products/:id', byId((r, id) => admin.deleteProduct(r, id)));
adminRouter.post('/modifier-groups/:id/modifiers', byId((r, id, b) => admin.createModifier(r, id, b as never), modifierCreateBody, 201));
adminRouter.patch('/modifiers/:id', byId((r, id, b) => admin.updateModifier(r, id, b as never), modifierUpdateBody));
adminRouter.delete('/modifiers/:id', byId((r, id) => admin.deleteModifier(r, id)));
adminRouter.patch('/combos/:id', byId((r, id, b) => admin.updateCombo(r, id, b as never), comboUpdateBody));

adminRouter.get(
  '/orders',
  wrap(async (req, res) => {
    const q = ordersQuery.parse(req.query);
    ok(res, await admin.listOrders(await restaurantId(), q));
  }),
);
adminRouter.get(
  '/orders/:id',
  wrap(async (req, res) => {
    const { id } = idParams.parse(req.params);
    ok(res, await admin.getOrderDetail(await restaurantId(), id));
  }),
);
adminRouter.patch(
  '/orders/:id/status',
  wrap(async (req, res) => {
    const { id } = idParams.parse(req.params);
    ok(res, await admin.setOrderStatus(await restaurantId(), id, orderStatusBody.parse(req.body).status));
  }),
);
adminRouter.get('/escalations', wrap(async (_req, res) => ok(res, await admin.listEscalations(await restaurantId()))));
