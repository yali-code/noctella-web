"use client";

import { useEffect, useState } from "react";
import { cancelPackingTask, completePackingTask, erpWarehouseApi, markPackingReady, startPackingTask, updatePackingTask } from "@/lib/erpWarehouseBridge";
import { ConfirmButton } from "@/components/lifecycle/ConfirmButton";

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-deep-star-blue)",
  border: "1px solid var(--noctella-antique-gold)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 13,
  marginRight: 6,
};

export default function PackingDetailPage({ params }: { params: { id: string } }) {
  const [task, setTask] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyCount, setBusyCount] = useState(0);

  function load() {
    setLoading(true);
    setLoadError(null);
    erpWarehouseApi
      .packingTask(params.id)
      .then((t) => {
        setTask(t);
        setPackageCount(String(t.package_count ?? 1));
        setTotalWeight(t.total_weight != null ? String(t.total_weight) : "");
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load packing task"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [params.id]);

  const [packageCount, setPackageCount] = useState("1");
  const [totalWeight, setTotalWeight] = useState("");

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading packing task...</p>;
  if (loadError && !task) return <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>;
  if (!task) return null;

  const blockedByOther = busyCount > 0;
  const canUpdate = ["Pending", "InProgress"].includes(task.status);

  return (
    <main>
      <h1>Packing Task {task.id}</h1>
      <p>Order {task.order_id} · Picking Task <a href={`/picking/${task.picking_task_id}`}>{task.picking_task_id}</a> · Status {task.status}</p>
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      <p>Packages {task.package_count ?? "—"} · Total weight {task.total_weight ?? "—"}</p>

      <section>
        <h2>Lines (read-only — derived from picked quantities)</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left" }}><th>Product</th><th>Quantity</th></tr>
          </thead>
          <tbody>
            {task.lines.map((l: any) => (
              <tr key={l.id}>
                <td>{l.product_id}</td>
                <td>{l.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Actions</h2>
        <ConfirmButton
          label="Start"
          eligible={task.status === "Pending"}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => startPackingTask(task.id, crypto.randomUUID()).then(() => {})}
        />
        <ConfirmButton
          label="Update Package Data"
          eligible={canUpdate}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => {
            const count = Number(packageCount);
            if (!Number.isInteger(count) || count <= 0) throw new Error("Package count must be a positive whole number");
            const weight = totalWeight === "" ? undefined : Number(totalWeight);
            if (weight !== undefined && weight < 0) throw new Error("Total weight cannot be negative");
            return updatePackingTask(task.id, crypto.randomUUID(), { packageCount: count, totalWeight: weight }).then(() => {});
          }}
        >
          <input style={inputStyle} type="number" min={1} placeholder="Package count" value={packageCount} onChange={(e) => setPackageCount(e.target.value)} />
          <input style={inputStyle} type="number" min={0} step="0.01" placeholder="Total weight (optional)" value={totalWeight} onChange={(e) => setTotalWeight(e.target.value)} />
        </ConfirmButton>
        <ConfirmButton
          label="Complete"
          eligible={task.status === "InProgress"}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => completePackingTask(task.id, crypto.randomUUID()).then(() => {})}
        />
        <ConfirmButton
          label="Mark Ready"
          eligible={task.status === "Packed"}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => markPackingReady(task.id, crypto.randomUUID()).then(() => {})}
        />
        <ConfirmButton
          label="Cancel Task"
          eligible={["Pending", "InProgress"].includes(task.status)}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => cancelPackingTask(task.id, crypto.randomUUID()).then(() => {})}
        />
      </section>
    </main>
  );
}
