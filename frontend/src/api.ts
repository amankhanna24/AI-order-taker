const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8000/api/v1';

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { token?: string; adminKey?: string } = {}): Promise<T> {
  const { token, adminKey, ...rest } = init;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (adminKey) headers['x-admin-key'] = adminKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(`${BASE}${path}`, { ...rest, headers, signal: controller.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) {
      throw new ApiFailure(res.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? 'Something went wrong. Please try again.');
    }
    return body.data as T;
  } catch (e) {
    if (e instanceof ApiFailure) throw e;
    if (e instanceof DOMException && e.name === 'AbortError') throw new ApiFailure(0, 'TIMEOUT', 'The request took too long. Please try again.');
    throw new ApiFailure(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  menu: () => request<import('./types').MenuData>('/menu'),
  start: () => request<import('./types').ConversationState & { token: string }>('/conversations', { method: 'POST', body: '{}' }),
  get: (id: string, token: string) => request<import('./types').ConversationState>(`/conversations/${id}`, { token }),
  send: (id: string, token: string, text: string) =>
    request<{ reply: string; state: string; escalated: boolean; order: import('./types').Order }>(`/conversations/${id}/messages`, {
      method: 'POST',
      token,
      body: JSON.stringify({ text }),
    }),
  confirm: (id: string, token: string, expectedVersion: number) =>
    request<{ order: import('./types').Order; state: string; message: string }>(`/conversations/${id}/confirm`, {
      method: 'POST',
      token,
      body: JSON.stringify({ expectedVersion }),
    }),
  cancel: (id: string, token: string) =>
    request<{ order: import('./types').Order; state: string }>(`/conversations/${id}/cancel`, { method: 'POST', token, body: '{}' }),
  admin: {
    menu: (k: string) => request<AdminMenu>('/admin/menu', { adminKey: k }),
    orders: (k: string, f: OrdersQuery) => {
      const p = new URLSearchParams({ page: String(f.page), limit: String(f.limit), tzOffset: String(new Date().getTimezoneOffset()) });
      if (f.from) p.set('from', f.from);
      if (f.to) p.set('to', f.to);
      if (f.item) p.set('item', f.item);
      if (f.status) p.set('status', f.status);
      return request<OrdersPage>(`/admin/orders?${p.toString()}`, { adminKey: k });
    },
    setOrderStatus: (k: string, id: string, status: string) =>
      request<import('./types').Order>(`/admin/orders/${id}/status`, { method: 'PATCH', adminKey: k, body: JSON.stringify({ status }) }),
    setAvailability: (k: string, kind: 'products' | 'modifiers' | 'combos', id: string, available: boolean) =>
      request<{ id: string; available: boolean }>(`/admin/${kind}/${id}/availability`, { method: 'PATCH', adminKey: k, body: JSON.stringify({ available }) }),
    setRestaurant: (k: string, body: { status?: string; orderingEnabled?: boolean }) =>
      request<{ status: string; orderingEnabled: boolean }>('/admin/restaurant', { method: 'PATCH', adminKey: k, body: JSON.stringify(body) }),
    createCategory: (k: string, body: { name: string; description?: string | null }) =>
      request<{ id: string }>('/admin/categories', { method: 'POST', adminKey: k, body: JSON.stringify(body) }),
    updateCategory: (k: string, id: string, body: { name?: string; description?: string | null }) =>
      request<{ id: string }>(`/admin/categories/${id}`, { method: 'PATCH', adminKey: k, body: JSON.stringify(body) }),
    deleteCategory: (k: string, id: string) => request<{ id: string }>(`/admin/categories/${id}`, { method: 'DELETE', adminKey: k }),
    createProduct: (k: string, body: ProductInput & { categoryId: string }) =>
      request<{ id: string }>('/admin/products', { method: 'POST', adminKey: k, body: JSON.stringify(body) }),
    updateProduct: (k: string, id: string, body: Partial<ProductInput> & { categoryId?: string; available?: boolean }) =>
      request<{ id: string }>(`/admin/products/${id}`, { method: 'PATCH', adminKey: k, body: JSON.stringify(body) }),
    deleteProduct: (k: string, id: string) => request<{ id: string; archived: boolean }>(`/admin/products/${id}`, { method: 'DELETE', adminKey: k }),
    createModifier: (k: string, groupId: string, body: { name: string; priceDelta: number }) =>
      request<{ id: string }>(`/admin/modifier-groups/${groupId}/modifiers`, { method: 'POST', adminKey: k, body: JSON.stringify(body) }),
    updateModifier: (k: string, id: string, body: { name?: string; priceDelta?: number; available?: boolean }) =>
      request<{ id: string }>(`/admin/modifiers/${id}`, { method: 'PATCH', adminKey: k, body: JSON.stringify(body) }),
    deleteModifier: (k: string, id: string) => request<{ id: string }>(`/admin/modifiers/${id}`, { method: 'DELETE', adminKey: k }),
    updateCombo: (k: string, id: string, body: { name?: string; description?: string | null; basePrice?: number }) =>
      request<{ id: string }>(`/admin/combos/${id}`, { method: 'PATCH', adminKey: k, body: JSON.stringify(body) }),
    escalations: (k: string) => request<{ id: string; reason: string; createdAt: string }[]>('/admin/escalations', { adminKey: k }),
  },
};

export interface OrdersQuery {
  page: number;
  limit: number;
  from?: string;
  to?: string;
  item?: string;
  status?: string;
}
export interface OrdersPage {
  orders: import('./types').Order[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export const ALLERGENS = ['MILK', 'EGG', 'PEANUTS', 'TREE_NUTS', 'SOY', 'GLUTEN', 'SESAME', 'MUSTARD'] as const;
export type AllergenName = (typeof ALLERGENS)[number];

export interface ProductInput {
  name: string;
  description: string | null;
  basePrice: number; // paise
  vegetarian: boolean;
  vegan: boolean;
  glutenFree: boolean;
  allergens: AllergenName[];
  allergenInfoVerified: boolean;
  aliases: string[];
  availableFrom: string | null;
  availableUntil: string | null;
}
export interface AdminModifier {
  id: string;
  groupId: string;
  name: string;
  group: string;
  priceDelta: number;
  available: boolean;
}
export interface AdminProduct extends ProductInput {
  id: string;
  available: boolean;
  modifiers: AdminModifier[];
}
export interface AdminCombo {
  id: string;
  name: string;
  description: string | null;
  basePrice: number;
  available: boolean;
}
export interface AdminMenu {
  restaurant: { name: string; status: string; orderingEnabled: boolean; currency: string };
  categories: { id: string; name: string; description: string | null; products: AdminProduct[] }[];
  combos: AdminCombo[];
}
