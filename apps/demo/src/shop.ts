import { randomBytes } from "node:crypto";

export interface Product {
  id: number;
  name: string;
  category: string;
  price: number;
  blurb: string;
}

export const PRODUCTS: Product[] = [
  { id: 1, name: "Boston Fern", category: "Ferns", price: 18, blurb: "Arching fronds that love a humid bathroom." },
  { id: 2, name: "Bird's Nest Fern", category: "Ferns", price: 22, blurb: "Wavy, glossy leaves from a nest-like centre." },
  { id: 3, name: "Snake Plant", category: "Easy care", price: 25, blurb: "Upright leaves that forgive a forgotten watering." },
  { id: 4, name: "ZZ Plant", category: "Easy care", price: 28, blurb: "Waxy leaves that do fine in a dim corner." },
  { id: 5, name: "Golden Pothos", category: "Easy care", price: 15, blurb: "A trailing vine for shelves and hanging pots." },
  { id: 6, name: "Fiddle Leaf Fig", category: "Statement", price: 45, blurb: "Big violin-shaped leaves for a bright room." },
  { id: 7, name: "Monstera", category: "Statement", price: 39, blurb: "Split leaves that grow as wide as they grow tall." },
  { id: 8, name: "Rubber Plant", category: "Statement", price: 32, blurb: "Dark, glossy leaves on a sturdy stem." },
  { id: 9, name: "Aloe Vera", category: "Succulents", price: 12, blurb: "A sunny windowsill and a drink every few weeks." },
  { id: 10, name: "Echeveria", category: "Succulents", price: 9, blurb: "A tight rosette in soft blue-green." },
  { id: 11, name: "Jade Plant", category: "Succulents", price: 14, blurb: "Thick leaves on a little tree trunk." },
  { id: 12, name: "Terracotta Pot", category: "Pots and tools", price: 8, blurb: "A 14 cm pot with a drainage hole and saucer." },
  { id: 13, name: "Watering Can", category: "Pots and tools", price: 19, blurb: "A one-litre can with a long, thin spout." },
];

export const CATEGORIES = [...new Set(PRODUCTS.map((p) => p.category))];

export const ACCOUNTS: Record<string, { password: string; name: string }> = {
  "ana@greenhouse.test": { password: "greenhouse-ana-2026", name: "Ana" },
  "lee@greenhouse.test": { password: "greenhouse-lee-2026", name: "Lee" },
  "sam@greenhouse.test": { password: "greenhouse-sam-2026", name: "Sam" },
};

export const WELCOME_CODE = "WELCOME10";

interface CartLine {
  productId: number;
  quantity: number;
  quantityWhenAdded: number;
}

export interface Order {
  id: number;
  lines: Array<{ name: string; quantity: number; price: number }>;
  total: number;
  address: { name: string; street: string; city: string; postcode: string };
  placedAt: Date;
}

export interface Session {
  email: string;
  displayName: string;
  cart: CartLine[];
  discountCode: string | null;
  orders: Order[];
  nextOrderId: number;
  touchedAt: number;
}

const MAX_SESSIONS = 20_000;
const MAX_ORDERS = 20;
export const MAX_QUANTITY = 20;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class Sessions {
  private readonly byId = new Map<string, Session>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  start(email: string, displayName: string): string {
    this.sweep();
    while (this.byId.size >= MAX_SESSIONS) this.byId.delete(this.byId.keys().next().value!);
    const id = randomBytes(24).toString("base64url");
    this.byId.set(id, { email, displayName, cart: [], discountCode: null, orders: [], nextOrderId: 1001, touchedAt: this.now() });
    return id;
  }

  get(id: string | undefined): Session | null {
    if (!id) return null;
    const session = this.byId.get(id);
    if (!session) return null;
    if (this.now() - session.touchedAt > SESSION_TTL_MS) {
      this.byId.delete(id);
      return null;
    }
    session.touchedAt = this.now();
    this.byId.delete(id);
    this.byId.set(id, session);
    return session;
  }

  end(id: string | undefined): void {
    if (id) this.byId.delete(id);
  }

  private sweep(): void {
    const cutoff = this.now() - SESSION_TTL_MS;
    for (const [id, session] of this.byId) {
      if (session.touchedAt >= cutoff) break;
      this.byId.delete(id);
    }
  }
}

export const productById = (id: number) => PRODUCTS.find((p) => p.id === id) ?? null;

export function search(query: string, category: string | null): Product[] {
  return PRODUCTS.filter((p) => (!category || p.category === category) && (!query || p.name.includes(query.trim())));
}

export function addToCart(session: Session, productId: number, quantity: number): void {
  const line = session.cart.find((l) => l.productId === productId);
  if (line) {
    line.quantity = Math.min(MAX_QUANTITY, line.quantity + quantity);
    line.quantityWhenAdded = Math.min(MAX_QUANTITY, line.quantityWhenAdded + quantity);
  } else {
    session.cart.push({ productId, quantity, quantityWhenAdded: quantity });
  }
}

export function setQuantity(session: Session, index: number, quantity: number): void {
  const line = session.cart[index];
  if (line) line.quantity = quantity;
}

export function removeLine(session: Session, index: number): void {
  if (index < 0 || index >= session.cart.length) return;
  session.cart.splice(session.cart.length === 1 ? 0 : index === 0 ? 1 : index - 1, 1);
}

export function cartLines(session: Session) {
  return session.cart.flatMap((line) => {
    const product = productById(line.productId);
    return product ? [{ product, quantity: line.quantity, subtotal: product.price * line.quantity }] : [];
  });
}

export function cartTotals(session: Session): { subtotal: number; discount: number; total: number } {
  const subtotal = session.cart.reduce((sum, line) => sum + (productById(line.productId)?.price ?? 0) * line.quantityWhenAdded, 0);
  const discount = session.discountCode === WELCOME_CODE ? Math.round(subtotal * 10) / 100 : 0;
  return { subtotal, discount, total: subtotal };
}

export const POSTCODE = /^[A-Z0-9]{3,8}$/i;

export function placeOrder(session: Session, address: Order["address"]): Order {
  const order: Order = {
    id: session.nextOrderId++,
    lines: cartLines(session).map((l) => ({ name: l.product.name, quantity: l.quantity, price: l.product.price })),
    total: cartTotals(session).total,
    address,
    placedAt: new Date(),
  };
  session.orders.push(order);
  if (session.orders.length > MAX_ORDERS) session.orders.shift();
  session.cart = [];
  session.discountCode = null;
  return order;
}

export const orderHistory = (session: Session): Order[] => session.orders.slice(0, -1).reverse();

export function saveDisplayName(session: Session, name: string): { saved: boolean } {
  const updated = { ...session, displayName: name };
  return { saved: updated.displayName === name };
}
