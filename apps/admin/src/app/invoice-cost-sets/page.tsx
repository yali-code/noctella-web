"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { invoiceIntakeApi, type InvoiceCostSet } from "@/lib/invoiceIntakes";

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 13,
  marginRight: 6,
};
const buttonStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };

export default function InvoiceCostSetsPage() {
  const router = useRouter();
  const [sets, setSets] = useState<InvoiceCostSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setLoadError(null);
    invoiceIntakeApi
      .listCostSets("pageSize=100")
      .then((res) => setSets(res.items ?? []))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load cost sets"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleCreate() {
    if (createBusy) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      if (!title.trim()) throw new Error("Cost set title is required");
      const created = await invoiceIntakeApi.createCostSet({ title: title.trim(), notes: notes.trim() || null });
      setFormOpen(false);
      setTitle("");
      setNotes("");
      router.push(`/invoice-cost-sets/${created.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create cost set");
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <main>
      <h1>Invoice Cost Sets</h1>
      <p>A cost set groups the invoices (auction, transport, forwarder) that together make up the cost of one lot or purchase.</p>

      <button style={buttonStyle} onClick={() => setFormOpen((v) => !v)}>{formOpen ? "Cancel" : "New cost set"}</button>

      {formOpen && (
        <section style={{ marginTop: 12 }}>
          <h2>New cost set</h2>
          <input style={{ ...inputStyle, minWidth: 320 }} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input style={{ ...inputStyle, minWidth: 320 }} placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div style={{ marginTop: 8 }}>
            <button disabled={createBusy} style={buttonStyle} onClick={handleCreate}>{createBusy ? "Creating…" : "Create cost set"}</button>
          </div>
          {createError && <p role="alert" style={{ color: "#c86a6a" }}>{createError}</p>}
        </section>
      )}

      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading cost sets...</p>}
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      {!loading && !loadError && sets.length === 0 && <p>No cost sets yet.</p>}

      {!loading && !loadError && sets.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>Title</th><th>Status</th><th>Created</th><th>Updated</th><th></th>
            </tr>
          </thead>
          <tbody>
            {sets.map((s) => (
              <tr key={s.id}>
                <td>{s.title}</td>
                <td>{s.status}</td>
                <td>{new Date(s.createdAt).toLocaleString()}</td>
                <td>{new Date(s.updatedAt).toLocaleString()}</td>
                <td><a href={`/invoice-cost-sets/${s.id}`}>View</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
