export interface OrderModifier {
  kind: 'ADD' | 'REMOVAL';
  name: string;
  price: number;
  quantity: number;
  source: 'EXPLICIT' | 'DEFAULT';
}
export interface OrderLine {
  lineRef: string;
  productId: string | null;
  comboId: string | null;
  name: string;
  quantity: number;
  unitTotal: number;
  lineTotal: number;
  modifiers: OrderModifier[];
  comboSelections: { component: string; productName: string }[] | null;
}
export interface Order {
  id: string;
  status: OrderStatus;
  version: number;
  currency: string;
  customerName: string | null;
  createdAt?: string;
  lines: OrderLine[];
  subtotal: number;
  discount: number;
  tax: number;
  fees: number;
  total: number;
  display: { subtotal: string; discount: string; tax: string; fees: string; total: string };
}
export type OrderStatus =
  | 'DRAFT'
  | 'IN_PROGRESS'
  | 'READY_FOR_CONFIRMATION'
  | 'CONFIRMED'
  | 'SUBMITTED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export interface Message {
  id: string;
  speaker: 'CUSTOMER' | 'AGENT' | 'SYSTEM';
  text: string;
  createdAt: string;
}
export interface ConversationState {
  conversationId: string;
  state: string;
  order: Order;
  messages: Message[];
  restaurant: { name: string; currency: string };
}
export interface MenuProduct {
  id: string;
  name: string;
  description: string | null;
  priceDisplay: string;
  available: boolean;
  unavailableReason: string | null;
  vegan: boolean;
  allergens: string[] | null;
}
export interface MenuData {
  restaurant: { name: string; status: string; orderingEnabled: boolean };
  categories: { name: string; products: MenuProduct[] }[];
  combos: { id: string; name: string; priceDisplay: string; available: boolean }[];
}
