import { beforeEach, expect, test } from "vitest";
import { handle } from "./app.ts";
import { ACCOUNTS, Sessions } from "./shop.ts";

let sessions: Sessions;
beforeEach(() => {
  sessions = new Sessions();
});

const ANA = { email: "ana@greenhouse.test", password: ACCOUNTS["ana@greenhouse.test"]!.password };

function browser() {
  let cookie = "";
  const send = async (method: string, path: string, form?: Record<string, string>) => {
    const res = await handle(new Request(`http://greenhouse.test${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    }), sessions);
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return res;
  };
  const text = async (res: Response) => (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return {
    get: async (path: string) => text(await send("GET", path)),
    post: (path: string, form: Record<string, string>) => send("POST", path, form),
    postText: async (path: string, form: Record<string, string>) => {
      const res = await send("POST", path, form);
      return text(res.status === 303 ? await send("GET", res.headers.get("location")!) : res);
    },
    send,
    signIn: () => send("POST", "/sign-in", { email: ANA.email, password: ANA.password, next: "/shop" }),
  };
}

test("every page but sign-in and the health check sends a visitor to sign in, and comes back after it", async () => {
  const b = browser();
  const res = await b.send("GET", "/cart?x=1");
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/sign-in?next=%2Fcart%3Fx%3D1");
  expect((await b.send("GET", "/healthz")).status).toBe(200);
  const signedIn = await b.post("/sign-in", { email: "ANA@greenhouse.test", password: ANA.password, next: "/cart?x=1" });
  expect(signedIn.headers.get("location")).toBe("/cart?x=1");
  expect(signedIn.headers.get("set-cookie")).toMatch(/^greenhouse_session=[\w-]{32}; Path=\/; HttpOnly; SameSite=Lax/);
  expect(await b.get("/cart")).toContain("Your cart is empty.");
});

test("a wrong password is refused without saying which part was wrong, and an outside next address is ignored", async () => {
  const b = browser();
  const wrong = await b.send("POST", "/sign-in", { email: ANA.email, password: "nope", next: "/shop" });
  expect(wrong.status).toBe(401);
  expect(await wrong.text()).toContain("Email or password is incorrect.");
  for (const email of ["constructor", "__proto__"]) expect((await b.send("POST", "/sign-in", { email, password: "x", next: "/shop" })).status).toBe(401);
  for (const next of ["//evil.test/x", "/\\evil.test", "/\t/evil.test", "https://evil.test/", "/%0a/evil.test".replace("%0a", "\n"), "/..//evil.test", "/./\\evil.test", "//["]) {
    const res = await browser().post("/sign-in", { ...ANA, next });
    expect(res.headers.get("location")).toBe("/shop");
  }
  const signedIn = await b.post("/sign-in", { ...ANA, next: "/orders?page=2" });
  expect(signedIn.headers.get("location")).toBe("/orders?page=2");
  expect((await b.send("GET", "/sign-in?next=%2F%5Cevil.test")).headers.get("location")).toBe("/shop");
});

test("a form sent after the session is gone asks to sign in and then opens the shop, not the form's address", async () => {
  const b = browser();
  const res = await b.post("/cart/add", { productId: "3", quantity: "1" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/sign-in");
});

test("a HEAD request is answered like the page it asks about", async () => {
  const b = browser();
  expect((await b.send("HEAD", "/sign-in")).status).toBe(200);
  await b.signIn();
  expect((await b.send("HEAD", "/shop")).status).toBe(200);
});

test("the cart keeps quantities within 1 to 20 and says so when a form asks for something it cannot do", async () => {
  const b = browser();
  await b.signIn();
  await b.post("/cart/add", { productId: "12", quantity: "15" });
  await b.post("/cart/add", { productId: "12", quantity: "15" });
  expect(await (await b.send("GET", "/cart")).text()).toContain('max="20" value="20"');
  expect(await b.postText("/cart/add", { productId: "12", quantity: "99" })).toContain("Enter a quantity from 1 to 20.");
  expect(await b.postText("/cart/quantity", { index: "5", quantity: "2" })).toContain("That plant is no longer in your cart.");
});

test("a session keeps its 20 latest orders", async () => {
  const b = browser();
  await b.signIn();
  for (let i = 0; i < 22; i++) {
    await b.post("/cart/add", { productId: "10", quantity: "1" });
    await b.post("/checkout", { name: "Ana", street: "1 Garden Row", city: "Leeds", postcode: "LS11AA" });
  }
  expect((await b.send("GET", "/orders/1002")).status).toBe(404);
  expect(await b.get("/orders/1003")).toContain("Order 1003 is placed");
  expect(await b.get("/orders/1022")).toContain("Order 1022 is placed");
});

test("signing out ends the session on the server, so the old cookie no longer opens the shop", async () => {
  const b = browser();
  const cookie = (await b.signIn()).headers.get("set-cookie")!.split(";")[0]!;
  await b.post("/sign-out", {});
  const replayed = await handle(new Request("http://greenhouse.test/shop", { headers: { cookie } }), sessions);
  expect(replayed.status).toBe(303);
  expect(replayed.headers.get("location")).toBe("/sign-in?next=%2Fshop");
});

test("the shop lists every plant, filters by category and finds a plant by its name as written", async () => {
  const b = browser();
  await b.signIn();
  const all = await b.get("/shop");
  expect(all).toContain("Boston Fern");
  expect(all).toContain("Watering Can");
  const succulents = await b.get("/shop?category=Succulents");
  expect(succulents).toContain("Aloe Vera");
  expect(succulents).not.toContain("Boston Fern");
  expect(await b.get("/shop?q=Fern")).toContain("Nest Fern");
});

test("seeded defect: search is case-sensitive, so a lowercase name finds nothing", async () => {
  const b = browser();
  await b.signIn();
  expect(await b.get("/shop?q=fern")).toContain("No plants match your search.");
});

test("a plant goes into the cart with its quantity, and an order is placed with a plain postcode", async () => {
  const b = browser();
  await b.signIn();
  expect((await b.post("/cart/add", { productId: "3", quantity: "2" })).headers.get("location")).toBe("/products/3?added=1");
  expect(await b.get("/products/3?added=1")).toContain("Added to your cart.");
  const cart = await b.get("/cart");
  expect(cart).toContain("Snake Plant");
  expect(cart).toContain("Total: $50.00");
  const placed = await b.post("/checkout", { name: "Ana Diaz", street: "1 Garden Row", city: "Leeds", postcode: "LS11AA" });
  expect(placed.headers.get("location")).toBe("/orders/1001");
  const order = await b.get("/orders/1001");
  expect(order).toContain("Order 1001 is placed");
  expect(order).toContain("Total: $50.00");
  expect(await b.get("/cart")).toContain("Your cart is empty.");
});

test("seeded defect: changing a quantity in the cart changes the line but not the total", async () => {
  const b = browser();
  await b.signIn();
  await b.post("/cart/add", { productId: "5", quantity: "1" });
  const cart = await b.postText("/cart/quantity", { index: "0", quantity: "3" });
  expect(cart).toContain("Quantity updated.");
  expect(cart).toContain("$45.00");
  expect(cart).toContain("Total: $15.00");
});

test("seeded defect: removing a plant from a cart of several removes its neighbour, while naming the chosen one", async () => {
  const b = browser();
  await b.signIn();
  for (const productId of ["9", "12", "3"]) await b.post("/cart/add", { productId, quantity: "1" });
  const second = await b.postText("/cart/remove", { index: "1" });
  expect(second).toContain("Terracotta Pot removed from your cart.");
  expect(second).toContain("Terracotta Pot $8.00");
  expect(second).not.toContain("Aloe Vera");
  const first = await b.postText("/cart/remove", { index: "0" });
  expect(first).toContain("Terracotta Pot removed from your cart.");
  expect(first).toContain("Terracotta Pot $8.00");
  expect(first).not.toContain("Snake Plant");
});

test("the last plant in the cart is removed as asked", async () => {
  const b = browser();
  await b.signIn();
  await b.post("/cart/add", { productId: "9", quantity: "1" });
  expect(await b.postText("/cart/remove", { index: "0" })).toContain("Your cart is empty.");
});

test("every cart form answers with a redirect, so reloading or going back never lands on a form address", async () => {
  const b = browser();
  await b.signIn();
  await b.post("/cart/add", { productId: "9", quantity: "1" });
  expect((await b.post("/cart/quantity", { index: "0", quantity: "2" })).headers.get("location")).toBe("/cart?updated=1");
  expect((await b.post("/cart/discount", { code: "WELCOME10" })).headers.get("location")).toBe("/cart?discount=1");
  expect((await b.post("/cart/discount", { code: "nope" })).headers.get("location")).toBe("/cart?error=code");
  expect((await b.post("/cart/add", { productId: "9", quantity: "0" })).headers.get("location")).toBe("/products/9?error=quantity");
  expect(await b.get("/products/9?error=quantity")).toContain("Enter a quantity from 1 to 20.");
  expect((await b.post("/cart/remove", { index: "0" })).headers.get("location")).toBe("/cart?removed=9");
  expect((await b.post("/cart/remove", { index: "0" })).headers.get("location")).toBe("/cart?error=gone");
  expect(await b.get("/cart?removed=999&error=nope")).not.toContain("removed from your cart");
  for (const error of ["constructor", "__proto__", "toString"]) expect((await b.send("GET", `/cart?error=${error}&removed=__proto__`)).status).toBe(200);
});

test("seeded defect: the welcome code is accepted and shown as a discount, but the total does not go down", async () => {
  const b = browser();
  await b.signIn();
  await b.post("/cart/add", { productId: "6", quantity: "1" });
  expect(await b.postText("/cart/discount", { code: "nope" })).toContain("That code is not valid.");
  const cart = await b.postText("/cart/discount", { code: "welcome10" });
  expect(cart).toContain("WELCOME10 applied: 10% off your order.");
  expect(cart).toContain("Discount (WELCOME10): −$4.50");
  expect(cart).toContain("Total: $45.00");
});

test("seeded defect: a postcode written the way the field's own example is written is refused", async () => {
  const b = browser();
  await b.signIn();
  await b.post("/cart/add", { productId: "1", quantity: "1" });
  const refused = await b.send("POST", "/checkout", { name: "Ana", street: "1 Garden Row", city: "London", postcode: "SW1A 1AA" });
  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain("Enter a valid postcode.");
  expect(await (await b.send("GET", "/checkout")).text()).toContain('placeholder="e.g. SW1A 1AA"');
});

test("seeded defect: the newest order is missing from the order history", async () => {
  const b = browser();
  await b.signIn();
  const order = async () => {
    await b.post("/cart/add", { productId: "10", quantity: "1" });
    return b.post("/checkout", { name: "Ana", street: "1 Garden Row", city: "Leeds", postcode: "LS11AA" });
  };
  await order();
  expect(await b.get("/orders")).toContain("You have no orders yet.");
  await order();
  const history = await b.get("/orders");
  expect(history).toContain("Order 1001");
  expect(history).not.toContain("Order 1002");
  expect(await b.get("/orders/1002")).toContain("Order 1002 is placed");
});

test("seeded defect: a new display name says Saved but is not kept", async () => {
  const b = browser();
  await b.signIn();
  const saved = await b.postText("/account", { displayName: "Ana Maria" });
  expect(saved).toContain("Saved.");
  expect(saved).toContain("Hi, Ana ");
  expect(await (await b.send("GET", "/account")).text()).toContain('name="displayName" value="Ana"');
  expect(await b.get("/shop")).toContain("Hi, Ana ");
});

test("each browser has its own cart, even on the same account", async () => {
  const first = browser();
  const second = browser();
  await first.signIn();
  await second.signIn();
  await first.post("/cart/add", { productId: "7", quantity: "1" });
  expect(await first.get("/cart")).toContain("Monstera");
  expect(await second.get("/cart")).toContain("Your cart is empty.");
});

test("sessions expire after 12 hours idle", async () => {
  let now = 0;
  const s = new Sessions(() => now);
  const id = s.start(ANA.email, "Ana");
  now = 11 * 60 * 60 * 1000;
  expect(s.get(id)).not.toBeNull();
  now = 22 * 60 * 60 * 1000;
  expect(s.get(id)).not.toBeNull();
  now += 12 * 60 * 60 * 1000 + 1;
  expect(s.get(id)).toBeNull();
});

test("what a person types is escaped on every page it shows up on", async () => {
  const b = browser();
  await b.signIn();
  await b.post("/cart/add", { productId: "1", quantity: "1" });
  const checkout = await (await b.send("POST", "/checkout", { name: "<img src=x>", street: "<b>1</b>", city: "<i>c</i>", postcode: "<p>" })).text();
  expect(checkout).not.toMatch(/<img src=x>|<b>1<\/b>|<i>c<\/i>|value="<p>"/);
  expect(checkout).toContain('value="&lt;img src=x&gt;"');
  const res = await b.send("GET", "/shop?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  const html = await res.text();
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
});
