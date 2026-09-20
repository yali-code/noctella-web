"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, customerApi, customerGoogleStartUrl } from "@/lib/api";

type Mode = "sign-in" | "register" | "forgot" | "reset" | "verify";
type Profile = { email: string; name: string | null; phone: string | null };
type Address = { id: string; type: "Shipping" | "Billing"; fullName: string; line1: string; line2?: string | null; city: string; region?: string | null; postalCode: string; country: string; countryCode: string };
type Order = { id: string; orderNumber: string; createdAt: string; status: string; totalAmount: number; currency: string };
type OrderDetail = Order & { items: Array<{ productTitle: string; quantity: number; totalPrice: number }>; shippingAddress?: { fullName?: string; city?: string; country?: string }; shippingMethodLabel?: string };
const blankAddress = (): Omit<Address, "id"> => ({ type: "Shipping", fullName: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "", countryCode: "" });

export default function AccountClient() {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [notice, setNotice] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingAddress, setEditingAddress] = useState<string | null>(null);
  const [address, setAddress] = useState(blankAddress);
  const [selectedOrder, setSelectedOrder] = useState<OrderDetail | null>(null);
  const refreshGeneration = useRef(0);

  async function refresh() {
    const generation = ++refreshGeneration.current;
    try {
      const me = await customerApi.get<Profile>("/api/customer-account/profile");
      if (generation !== refreshGeneration.current) return;
      setProfile(me); setName(me.name ?? ""); setPhone(me.phone ?? "");
      const [saved, history] = await Promise.all([
        customerApi.get<{ items: Address[] }>("/api/customer-account/addresses").catch(() => ({ items: [] })),
        customerApi.get<{ items: Order[] }>("/api/customer-account/orders").catch(() => ({ items: [] })),
      ]);
      if (generation !== refreshGeneration.current) return;
      setAddresses(saved.items); setOrders(history.items);
    } catch (error) {
      if (generation !== refreshGeneration.current) return;
      if (!(error instanceof ApiError && error.status === 401)) setNotice("Account details could not be loaded. Please try again.");
      setProfile(null);
    }
  }
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("mode");
    setHasToken(Boolean(params.get("token")));
    if (["register", "forgot", "reset", "verify"].includes(requested ?? "")) setMode(requested as Mode);
    if (params.get("google") === "unavailable") setNotice("Google sign-in is unavailable. Email and password remain available.");
    void refresh();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice("");
    try {
      if (mode === "register") {
        await customerApi.post("/api/customer-auth/register", { email, password, name, termsAccepted });
        setPassword(""); setNotice("Check your email to verify your account. Guest checkout remains available."); setMode("verify");
      } else if (mode === "sign-in") {
        await customerApi.post("/api/customer-auth/login", { email, password }); setPassword(""); await refresh();
      } else if (mode === "forgot") {
        await customerApi.post("/api/customer-auth/forgot-password", { email }); setNotice("If an account exists, we sent reset instructions.");
      } else if (mode === "verify") {
        const token = new URLSearchParams(window.location.search).get("token");
        if (token) { await customerApi.post("/api/customer-auth/verify-email", { token }); window.history.replaceState(null, "", "/account"); setNotice("Email verified. You can now sign in."); setMode("sign-in"); }
        else { await customerApi.post("/api/customer-auth/resend-verification", { email }); setNotice("If verification is needed, a new email has been sent."); }
      } else {
        const token = new URLSearchParams(window.location.search).get("token");
        await customerApi.post("/api/customer-auth/reset-password", { token, password });
        window.history.replaceState(null, "", "/account"); setPassword(""); setProfile(null); setNotice("Password changed. Please sign in."); setMode("sign-in");
      }
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "The request could not be completed. Please try again."); }
    finally { setBusy(false); }
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { await customerApi.patch("/api/customer-account/profile", { name, phone }); await refresh(); setNotice("Profile updated."); }
    catch { setNotice("Profile could not be updated."); } finally { setBusy(false); }
  }
  async function saveAddress(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      if (editingAddress) await customerApi.put(`/api/customer-account/addresses/${encodeURIComponent(editingAddress)}`, address);
      else await customerApi.post("/api/customer-account/addresses", address);
      setAddress(blankAddress()); setEditingAddress(null); await refresh(); setNotice("Address saved.");
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "Address could not be saved."); }
    finally { setBusy(false); }
  }
  async function removeAddress(id: string) {
    if (!window.confirm("Delete this saved address?")) return;
    try { await customerApi.delete(`/api/customer-account/addresses/${encodeURIComponent(id)}`); await refresh(); }
    catch { setNotice("Address could not be deleted."); }
  }
  async function showOrder(id: string) {
    try { setSelectedOrder(await customerApi.get<OrderDetail>(`/api/customer-account/orders/${encodeURIComponent(id)}`)); }
    catch { setNotice("Order details could not be loaded."); }
  }
  async function logout() {
    ++refreshGeneration.current;
    try { await customerApi.post("/api/customer-auth/logout", {}); }
    finally { setProfile(null); setMode("sign-in"); setAddresses([]); setOrders([]); setSelectedOrder(null); }
  }

  return <section style={{ maxWidth: 780, margin: "0 auto", padding: "48px 20px", color: "var(--noctella-ivory)" }}>
    <h1>Customer Account</h1>
    {notice && <p role="status">{notice}</p>}
    {!profile || (hasToken && (mode === "reset" || mode === "verify")) ? <>
      <nav aria-label="Account options" style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setMode("sign-in")}>Sign in</button>
        <button type="button" onClick={() => setMode("register")}>Create account</button>
        <button type="button" onClick={() => setMode("forgot")}>Forgot password</button>
        <button type="button" onClick={() => setMode("verify")}>Resend verification</button>
      </nav>
      <p>Customer accounts are optional. <Link href="/checkout">Guest checkout</Link> remains available.</p>
      <form onSubmit={submit} style={{ display: "grid", gap: 14, maxWidth: 480 }}>
        <h2>{({ "sign-in": "Sign in", register: "Create account", forgot: "Forgot password", reset: "Reset password", verify: "Verify email" })[mode]}</h2>
        {mode === "register" && <label>Full name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>}
        {mode !== "reset" && !(mode === "verify" && hasToken) && <label>Email<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>}
        {["sign-in", "register", "reset"].includes(mode) && <label>Password<input required type="password" minLength={mode === "sign-in" ? 1 : 12} maxLength={256} autoComplete={mode === "sign-in" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
        {mode === "register" && <label><input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} required /> I acknowledge creation of a Customer account using these details. Marketing consent is not automatically granted.</label>}
        <button disabled={busy} type="submit">{busy ? "Please wait…" : ({ "sign-in": "Sign in", register: "Create account", forgot: "Send reset link", reset: "Set new password", verify: "Verify or resend" })[mode]}</button>
      </form>
      <p><a href={customerGoogleStartUrl}>Continue with Google</a></p>
    </> : <>
      <p>Signed in as {profile.email}. <button type="button" onClick={() => void logout()}>Log out</button></p>
      <form onSubmit={saveProfile} style={{ display: "grid", gap: 12, maxWidth: 480 }}>
        <h2>Profile</h2><label>Name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Phone<input value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
        <button disabled={busy}>Save profile</button>
      </form>
      <h2>Saved addresses</h2>
      {addresses.length === 0 && <p>No addresses saved yet.</p>}
      {addresses.map((item) => <div key={item.id} style={{ marginBottom: 12 }}><p>{item.type}: {item.fullName}, {item.line1}, {item.city}, {item.country}</p><button type="button" onClick={() => { const { id, ...fields } = item; setAddress(fields); setEditingAddress(id); }}>Edit</button> <button type="button" onClick={() => void removeAddress(item.id)}>Delete</button></div>)}
      <form onSubmit={saveAddress} style={{ display: "grid", gap: 10, maxWidth: 480 }}>
        <h3>{editingAddress ? "Edit address" : "Add address"}</h3>
        <label>Type<select value={address.type} onChange={(event) => setAddress({ ...address, type: event.target.value as "Shipping" | "Billing" })}><option>Shipping</option><option>Billing</option></select></label>
        {(["fullName", "line1", "line2", "city", "region", "postalCode", "country", "countryCode"] as const).map((field) => <label key={field}>{field}<input required={field !== "line2" && field !== "region"} value={address[field] ?? ""} onChange={(event) => setAddress({ ...address, [field]: event.target.value })} /></label>)}
        <button disabled={busy}>Save address</button>
      </form>
      <h2>My Orders</h2>
      {orders.length === 0 && <p>No linked orders yet.</p>}
      {orders.map((order) => <div key={order.id}><button type="button" onClick={() => void showOrder(order.id)}>{order.orderNumber} — {order.createdAt.slice(0, 10)} — {order.status} — {order.currency} {order.totalAmount.toFixed(2)}</button></div>)}
      {selectedOrder && <article><h3>Order {selectedOrder.orderNumber}</h3>
        <p>{selectedOrder.status} · {selectedOrder.currency} {selectedOrder.totalAmount.toFixed(2)}</p>
        {selectedOrder.shippingMethodLabel && <p>Shipping: {selectedOrder.shippingMethodLabel}</p>}
        {selectedOrder.shippingAddress && <p>Deliver to {selectedOrder.shippingAddress.fullName}, {selectedOrder.shippingAddress.city}, {selectedOrder.shippingAddress.country}</p>}
        <ul>{selectedOrder.items.map((item, index) => <li key={index}>{item.productTitle} × {item.quantity} — {selectedOrder.currency} {item.totalPrice.toFixed(2)}</li>)}</ul>
      </article>}
    </>}
  </section>;
}
