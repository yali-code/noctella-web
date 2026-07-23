"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createPickingTask, erpWarehouseApi, mapPicking } from "@/lib/erpWarehouseBridge";

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

export default function PickingPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [formKey, setFormKey] = useState<string | null>(null);
  const [orderId, setOrderId] = useState("");
  const [safeNotes, setSafeNotes] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setLoadError(null);
    erpWarehouseApi
      .picking()
      .then((res) => setTasks(res.items ?? []))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load picking tasks"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function openForm() {
    setFormOpen(true);
    setFormKey(crypto.randomUUID());
    setCreateError(null);
  }
  function closeForm() {
    setFormOpen(false);
    setFormKey(null);
  }

  async function handleCreate() {
    if (createBusy || !formKey) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      if (!orderId.trim()) throw new Error("Order ID is required");
      const created = await createPickingTask(orderId.trim(), formKey, { safeNotes: safeNotes.trim() || undefined });
      closeForm();
      setOrderId("");
      setSafeNotes("");
      router.push(`/picking/${created.pickingTaskId}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create picking task");
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <main>
      <h1>Picking</h1>
      <p>ERP warehouse bridge workspace. Use authenticated ERP API projections for operational data and safe command actions.</p>

      <button style={buttonStyle} onClick={() => (formOpen ? closeForm() : openForm())}>{formOpen ? "Cancel" : "Create Picking Task"}</button>

      {formOpen && (
        <section style={{ marginTop: 12 }}>
          <h2>Create Picking Task</h2>
          <input style={inputStyle} placeholder="Order ID" value={orderId} onChange={(e) => setOrderId(e.target.value)} />
          <input style={inputStyle} placeholder="Notes (optional)" value={safeNotes} onChange={(e) => setSafeNotes(e.target.value)} />
          <div style={{ marginTop: 8 }}>
            <button disabled={createBusy} style={buttonStyle} onClick={handleCreate}>{createBusy ? "Creating…" : "Submit Picking Task"}</button>
          </div>
          {createError && <p role="alert" style={{ color: "#c86a6a" }}>{createError}</p>}
        </section>
      )}

      {loading && <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading picking tasks...</p>}
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      {!loading && !loadError && tasks.length === 0 && <p>No picking tasks found.</p>}

      {!loading && !loadError && tasks.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr style={{ textAlign: "left" }}><th>Order</th><th>Status</th></tr>
          </thead>
          <tbody>
            {tasks.map((row) => {
              const t = mapPicking(row);
              return (
                <tr key={t.id}>
                  <td>{t.orderId}</td>
                  <td>{t.status}</td>
                  <td><a href={`/picking/${t.id}`}>View</a></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
