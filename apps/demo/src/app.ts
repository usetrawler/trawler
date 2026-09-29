import { timingSafeEqual } from "node:crypto";
import {
  ACCOUNTS, addToCart, cartLines, cartTotals, CATEGORIES, orderHistory, placeOrder, POSTCODE, productById, removeLine, saveDisplayName, search, setQuantity, WELCOME_CODE,
  type Order, type Session, type Sessions,
} from "./shop.ts";

const COOKIE = "greenhouse_session";
const MAX_BODY_BYTES = 16_384;

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number) => `$${n.toFixed(2)}`;

const STYLE = `
:root { color-scheme: light; --ink: #1f2a22; --muted: #5b675e; --line: #d6ddd3; --panel: #f4f7f2; --accent: #2f6b3f; --bad: #a23b2a; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--ink); background: #fff; }
header { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between; padding: 12px 24px; border-bottom: 1px solid var(--line); }
header nav { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
a { color: var(--accent); }
main { max-width: 960px; margin: 0 auto; padding: 24px; }
h1 { font-size: 28px; margin: 0 0 16px; }
.brand { font-weight: 700; text-decoration: none; color: var(--ink); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; padding: 0; list-style: none; }
.card { border: 1px solid var(--line); background: var(--panel); padding: 16px; }
.muted { color: var(--muted); }
.notice { border-left: 3px solid var(--accent); padding: 8px 12px; background: var(--panel); }
.error { border-left: 3px solid var(--bad); padding: 8px 12px; color: var(--bad); }
form.stack { display: grid; gap: 12px; max-width: 420px; }
label { display: grid; gap: 4px; }
input, select, button { font: inherit; padding: 8px 10px; }
button { background: var(--accent); color: #fff; border: 0; cursor: pointer; }
button.link { background: none; color: var(--accent); padding: 0; text-decoration: underline; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); }
.inline { display: inline-flex; gap: 8px; align-items: center; }
`;

function page(title: string, body: string, session: Session | null, status = 200): Response {
  const nav = session
    ? `<nav aria-label="Main">
        <a href="/shop">Shop</a>
        <a href="/cart">Cart (${session.cart.reduce((n, l) => n + l.quantity, 0)})</a>
        <a href="/orders">Orders</a>
        <a href="/account">Account</a>
        <span class="muted">Hi, ${escape(session.displayName)}</span>
        <form method="post" action="/sign-out"><button class="link" type="submit">Sign out</button></form>
      </nav>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Greenhouse</title><style>${STYLE}</style></head>
<body><header><a class="brand" href="/">Greenhouse</a>${nav}</header><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" } });
}

const redirect = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store", ...headers } });

function cookieOf(req: Request): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return undefined;
}

async function formOf(req: Request): Promise<URLSearchParams | null> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return null;
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return null;
  return new URLSearchParams(text);
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const SAME_ORIGIN = "http://greenhouse.invalid";

function localPath(next: string | null): string {
  if (!next || !next.startsWith("/") || !URL.canParse(next, SAME_ORIGIN)) return "/shop";
  const url = new URL(next, SAME_ORIGIN);
  return url.origin === SAME_ORIGIN && !url.pathname.startsWith("//") ? url.pathname + url.search : "/shop";
}

function signInPage(error: string | null, next: string, email = "", status = 200): Response {
  return page("Sign in", `
<h1>Sign in to Greenhouse</h1>
<p class="muted">Plants and pots, delivered.</p>
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}
<form class="stack" method="post" action="/sign-in">
  <input type="hidden" name="next" value="${escape(next)}">
  <label>Email <input name="email" type="email" autocomplete="username" required value="${escape(email)}"></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in</button>
</form>`, null, status);
}

function productCard(p: { id: number; name: string; category: string; price: number }): string {
  return `<li class="card"><a href="/products/${p.id}"><strong>${escape(p.name)}</strong></a><br><span class="muted">${escape(p.category)}</span><br>${money(p.price)}</li>`;
}

function shopPage(session: Session, url: URL): Response {
  const query = (url.searchParams.get("q") ?? "").slice(0, 100);
  const category = CATEGORIES.includes(url.searchParams.get("category") ?? "") ? url.searchParams.get("category") : null;
  const found = search(query, category);
  const options = CATEGORIES.map((c) => `<option value="${escape(c)}"${c === category ? " selected" : ""}>${escape(c)}</option>`).join("");
  return page("Shop", `
<h1>Shop</h1>
<p class="notice">New here? Use code <strong>${WELCOME_CODE}</strong> in your cart for 10% off your first order.</p>
<form class="inline" method="get" action="/shop" role="search">
  <label>Search plants <input name="q" type="search" value="${escape(query)}"></label>
  <label>Category <select name="category"><option value="">All</option>${options}</select></label>
  <button type="submit">Search</button>
</form>
${found.length ? `<ul class="grid">${found.map(productCard).join("")}</ul>` : `<p>No plants match your search.</p>`}`, session);
}

function productPage(session: Session, id: number, added: boolean, error: string | null = null): Response {
  const product = productById(id);
  if (!product) return page("Not found", `<h1>We could not find that plant.</h1><p><a href="/shop">Back to the shop</a></p>`, session, 404);
  return page(product.name, `
<p><a href="/shop">← Shop</a></p>
<h1>${escape(product.name)}</h1>
<p class="muted">${escape(product.category)}</p>
<p>${escape(product.blurb)}</p>
<p><strong>${money(product.price)}</strong></p>
${added ? `<p class="notice" role="status">Added to your cart. <a href="/cart">View cart</a></p>` : ""}${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}
<form class="inline" method="post" action="/cart/add">
  <input type="hidden" name="productId" value="${product.id}">
  <label>Quantity <input name="quantity" type="number" min="1" max="20" value="1" required></label>
  <button type="submit">Add to cart</button>
</form>`, session);
}

const QUANTITY_RANGE = "Enter a quantity from 1 to 20.";
const CART_ERRORS = new Map([["quantity", QUANTITY_RANGE], ["gone", "That plant is no longer in your cart."], ["code", "That code is not valid."]]);

function cartNotice(params: URLSearchParams): string | null {
  if (params.has("updated")) return "Quantity updated.";
  if (params.has("discount")) return `${WELCOME_CODE} applied: 10% off your order.`;
  const removed = productById(Number(params.get("removed")));
  return removed ? `${removed.name} removed from your cart.` : null;
}

function cartPage(session: Session, notice: string | null, error: string | null): Response {
  const lines = cartLines(session);
  const totals = cartTotals(session);
  const rows = lines.map((l, i) => `
<tr>
  <td><a href="/products/${l.product.id}">${escape(l.product.name)}</a></td>
  <td>${money(l.product.price)}</td>
  <td><form class="inline" method="post" action="/cart/quantity"><input type="hidden" name="index" value="${i}"><label>Quantity of ${escape(l.product.name)} <input name="quantity" type="number" min="1" max="20" value="${l.quantity}" required></label><button type="submit" aria-label="Update quantity of ${escape(l.product.name)}">Update</button></form></td>
  <td>${money(l.subtotal)}</td>
  <td><form method="post" action="/cart/remove"><input type="hidden" name="index" value="${i}"><button class="link" type="submit" aria-label="Remove ${escape(l.product.name)}">Remove</button></form></td>
</tr>`).join("");
  const body = lines.length
    ? `
<table>
  <thead><tr><th>Plant</th><th>Price</th><th>Quantity</th><th>Subtotal</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<form class="inline" method="post" action="/cart/discount">
  <label>Discount code <input name="code" autocomplete="off"></label>
  <button type="submit">Apply</button>
</form>
<p>Items: ${money(totals.subtotal)}${totals.discount ? `<br>Discount (${WELCOME_CODE}): −${money(totals.discount)}` : ""}<br><strong>Total: ${money(totals.total)}</strong></p>
<p><a href="/checkout">Go to checkout</a></p>`
    : `<p>Your cart is empty. <a href="/shop">Browse the shop</a></p>`;
  return page("Cart", `<h1>Your cart</h1>${notice ? `<p class="notice" role="status">${escape(notice)}</p>` : ""}${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}${body}`, session);
}

type Address = Order["address"];

function checkoutPage(session: Session, address: Address, error: string | null, status = 200): Response {
  const totals = cartTotals(session);
  if (!session.cart.length) return page("Checkout", `<h1>Checkout</h1><p>Your cart is empty. <a href="/shop">Browse the shop</a></p>`, session);
  const field = (name: keyof Address, label: string, extra = "") => `<label>${label} <input name="${name}" value="${escape(address[name])}" required ${extra}></label>`;
  return page("Checkout", `
<h1>Checkout</h1>
<p>Order total: <strong>${money(totals.total)}</strong></p>
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}
<form class="stack" method="post" action="/checkout">
  ${field("name", "Full name", 'autocomplete="name"')}
  ${field("street", "Street and number", 'autocomplete="address-line1"')}
  ${field("city", "City", 'autocomplete="address-level2"')}
  ${field("postcode", "Postcode", 'autocomplete="postal-code" placeholder="e.g. SW1A 1AA"')}
  <button type="submit">Place order</button>
</form>`, session, status);
}

function orderPage(session: Session, order: Order): Response {
  return page(`Order ${order.id}`, `
<h1>Order ${order.id} is placed</h1>
<p class="notice" role="status">Thank you! We will send your plants to ${escape(order.address.name)}, ${escape(order.address.street)}, ${escape(order.address.postcode)} ${escape(order.address.city)}.</p>
<table><thead><tr><th>Plant</th><th>Quantity</th><th>Price</th></tr></thead><tbody>
${order.lines.map((l) => `<tr><td>${escape(l.name)}</td><td>${l.quantity}</td><td>${money(l.price)}</td></tr>`).join("")}
</tbody></table>
<p><strong>Total: ${money(order.total)}</strong></p>
<p><a href="/orders">All your orders</a> · <a href="/shop">Keep shopping</a></p>`, session);
}

function ordersPage(session: Session): Response {
  const orders = orderHistory(session);
  return page("Orders", `
<h1>Your orders</h1>
${orders.length ? `<table><thead><tr><th>Order</th><th>Items</th><th>Total</th></tr></thead><tbody>${orders.map((o) => `<tr><td><a href="/orders/${o.id}">Order ${o.id}</a></td><td>${o.lines.reduce((n, l) => n + l.quantity, 0)}</td><td>${money(o.total)}</td></tr>`).join("")}</tbody></table>` : `<p>You have no orders yet.</p>`}`, session);
}

function accountPage(session: Session, notice: string | null, error: string | null): Response {
  return page("Account", `
<h1>Your account</h1>
<p>Signed in as ${escape(session.email)}.</p>
${notice ? `<p class="notice" role="status">${escape(notice)}</p>` : ""}${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}
<form class="stack" method="post" action="/account">
  <label>Display name <input name="displayName" value="${escape(session.displayName)}" maxlength="60" required></label>
  <button type="submit">Save</button>
</form>`, session);
}

const int = (value: string | null, min: number, max: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

export async function handle(req: Request, sessions: Sessions): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method === "HEAD" ? "GET" : req.method;
  const path = url.pathname;
  if (path === "/healthz") return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  const id = cookieOf(req);
  const session = sessions.get(id);
  const secure = req.headers.get("x-forwarded-proto") === "https" || url.protocol === "https:";
  const cookie = (value: string, maxAge: number) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  if (path === "/sign-in") {
    if (method === "GET") return session ? redirect(localPath(url.searchParams.get("next"))) : signInPage(null, localPath(url.searchParams.get("next")));
    if (method !== "POST") return new Response(null, { status: 405 });
    const form = await formOf(req);
    if (!form) return new Response("Too large", { status: 413 });
    const email = (form.get("email") ?? "").trim().toLowerCase();
    const next = localPath(form.get("next"));
    const account = Object.hasOwn(ACCOUNTS, email) ? ACCOUNTS[email] : undefined;
    if (!account || !sameSecret(form.get("password") ?? "", account.password)) return signInPage("Email or password is incorrect.", next, email, 401);
    return redirect(next, { "set-cookie": cookie(sessions.start(email, account.name), 12 * 60 * 60) });
  }
  if (path === "/sign-out" && req.method === "POST") {
    sessions.end(id);
    return redirect("/sign-in", { "set-cookie": cookie("", 0) });
  }
  if (!session) return redirect(method === "GET" ? `/sign-in?next=${encodeURIComponent(path + url.search)}` : "/sign-in");

  if (method === "GET") {
    if (path === "/") return redirect("/shop");
    if (path === "/shop") return shopPage(session, url);
    const product = /^\/products\/(\d{1,4})$/.exec(path);
    if (product) return productPage(session, Number(product[1]), url.searchParams.has("added"), url.searchParams.get("error") === "quantity" ? QUANTITY_RANGE : null);
    if (path === "/cart") return cartPage(session, cartNotice(url.searchParams), CART_ERRORS.get(url.searchParams.get("error") ?? "") ?? null);
    if (path === "/checkout") return checkoutPage(session, { name: "", street: "", city: "", postcode: "" }, null);
    if (path === "/orders") return ordersPage(session);
    const order = /^\/orders\/(\d{1,6})$/.exec(path);
    if (order) {
      const found = session.orders.find((o) => o.id === Number(order[1]));
      return found ? orderPage(session, found) : page("Not found", `<h1>We could not find that order.</h1><p><a href="/orders">Your orders</a></p>`, session, 404);
    }
    if (path === "/account") return accountPage(session, null, null);
    return page("Not found", `<h1>We could not find that page.</h1><p><a href="/shop">Back to the shop</a></p>`, session, 404);
  }
  if (method !== "POST") return new Response(null, { status: 405 });
  const form = await formOf(req);
  if (!form) return new Response("Too large", { status: 413 });

  if (path === "/cart/add") {
    const productId = int(form.get("productId"), 1, 9999);
    const quantity = int(form.get("quantity"), 1, 20);
    if (!productId || !productById(productId)) return page("Not found", `<h1>We could not find that plant.</h1>`, session, 404);
    if (!quantity) return redirect(`/products/${productId}?error=quantity`);
    addToCart(session, productId, quantity);
    return redirect(`/products/${productId}?added=1`);
  }
  if (path === "/cart/quantity") {
    const index = int(form.get("index"), 0, 99);
    const quantity = int(form.get("quantity"), 1, 20);
    if (index === null || quantity === null) return redirect("/cart?error=quantity");
    if (!session.cart[index]) return redirect("/cart?error=gone");
    setQuantity(session, index, quantity);
    return redirect("/cart?updated=1");
  }
  if (path === "/cart/remove") {
    const index = int(form.get("index"), 0, 99);
    const removed = index === null ? undefined : cartLines(session)[index]?.product;
    if (!removed || index === null) return redirect("/cart?error=gone");
    removeLine(session, index);
    return redirect(`/cart?removed=${removed.id}`);
  }
  if (path === "/cart/discount") {
    const code = (form.get("code") ?? "").trim().toUpperCase();
    if (code !== WELCOME_CODE) return redirect("/cart?error=code");
    session.discountCode = code;
    return redirect("/cart?discount=1");
  }
  if (path === "/checkout") {
    const address: Address = { name: (form.get("name") ?? "").trim().slice(0, 100), street: (form.get("street") ?? "").trim().slice(0, 200), city: (form.get("city") ?? "").trim().slice(0, 100), postcode: (form.get("postcode") ?? "").trim().slice(0, 20) };
    if (!session.cart.length) return checkoutPage(session, address, null);
    if (!address.name || !address.street || !address.city) return checkoutPage(session, address, "Fill in your name, street and city.", 400);
    if (!POSTCODE.test(address.postcode)) return checkoutPage(session, address, "Enter a valid postcode.", 400);
    return redirect(`/orders/${placeOrder(session, address).id}`);
  }
  if (path === "/account") {
    const name = (form.get("displayName") ?? "").trim();
    if (!name || name.length > 60) return accountPage(session, null, "Enter a display name of up to 60 characters.");
    return accountPage(session, saveDisplayName(session, name).saved ? "Saved." : null, null);
  }
  return page("Not found", `<h1>We could not find that page.</h1>`, session, 404);
}
