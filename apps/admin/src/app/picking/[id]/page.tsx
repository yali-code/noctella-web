"use client";

import { useEffect, useState } from "react";
import { cancelPickingTask, completePickingTask, confirmPickedLine, erpWarehouseApi, markPickingShort, startPickingTask } from "@/lib/erpWarehouseBridge";
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
const buttonStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };

export default function PickingDetailPage({ params }: { params: { id: string } }) {
  const [task, setTask] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyCount, setBusyCount] = useState(0);

  function load() {
    setLoading(true);
    setLoadError(null);
    erpWarehouseApi
      .pickingTask(params.id)
      .then(setTask)
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load picking task"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [params.id]);

  const [armedLine, setArmedLine] = useState<{ lineId: string; action: "confirm" | "short"; key: string } | null>(null);
  const [qtyInput, setQtyInput] = useState("");
  const [lineBusy, setLineBusy] = useState(false);
  const [lineError, setLineError] = useState<string | null>(null);

  function armLine(lineId: string, action: "confirm" | "short", defaultQty: number) {
    setArmedLine({ lineId, action, key: crypto.randomUUID() });
    setQtyInput(String(defaultQty));
    setLineError(null);
  }
  function cancelLineForm() {
    setArmedLine(null);
    setLineError(null);
  }

  async function submitLine() {
    if (lineBusy || !armedLine) return;
    setLineBusy(true);
    setBusyCount((c) => c + 1);
    setLineError(null);
    try {
      const line = task.lines.find((l: any) => l.id === armedLine.lineId);
      const qty = Number(qtyInput);
      if (!Number.isInteger(qty) || qty < 0) throw new Error("Quantity must be a non-negative whole number");
      if (qty > line.requested_quantity) throw new Error(`Quantity cannot exceed the requested quantity (${line.requested_quantity})`);
      if (armedLine.action === "confirm") await confirmPickedLine(task.id, armedLine.lineId, armedLine.key, qty);
      else await markPickingShort(task.id, armedLine.lineId, armedLine.key, qty);
      setArmedLine(null);
      load();
    } catch (err) {
      setLineError(err instanceof Error ? err.message : "Failed to update line");
    } finally {
      setLineBusy(false);
      setBusyCount((c) => c - 1);
    }
  }

  if (loading) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading picking task...</p>;
  if (loadError && !task) return <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>;
  if (!task) return null;

  const blockedByOther = busyCount > 0;

  return (
    <main>
      <h1>Picking Task {task.id}</h1>
      <p>Order {task.order_id} · Status {task.status}</p>
      {loadError && <p role="alert" style={{ color: "#c86a6a" }}>{loadError}</p>}
      {task.safe_notes && <p>Notes: {task.safe_notes}</p>}

      <section>
        <h2>Lines</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left" }}><th>Product</th><th>Requested</th><th>Picked</th><th>Short</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {task.lines.map((l: any) => (
              <tr key={l.id}>
                <td>{l.product_id}</td>
                <td>{l.requested_quantity}</td>
                <td>{l.picked_quantity}</td>
                <td>{l.short_quantity}</td>
                <td>
                  {task.status === "InProgress" && (
                    <>
                      <button style={buttonStyle} disabled={blockedByOther} onClick={() => armLine(l.id, "confirm", l.requested_quantity - l.short_quantity)}>Confirm picked</button>
                      <button style={buttonStyle} disabled={blockedByOther} onClick={() => armLine(l.id, "short", l.requested_quantity - l.picked_quantity)}>Mark short</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {armedLine && (
          <div style={{ marginTop: 8 }}>
            <span style={{ fontSize: 13, marginRight: 6 }}>{armedLine.action === "confirm" ? "Picked quantity" : "Short quantity"}:</span>
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={task.lines.find((l: any) => l.id === armedLine.lineId)?.requested_quantity}
              value={qtyInput}
              onChange={(e) => setQtyInput(e.target.value)}
            />
            <button disabled={lineBusy} style={buttonStyle} onClick={submitLine}>{lineBusy ? "Submitting…" : `Confirm ${armedLine.action === "confirm" ? "Picked" : "Short"}`}</button>
            <button disabled={lineBusy} style={buttonStyle} onClick={cancelLineForm}>Cancel</button>
            {lineError && <p role="alert" style={{ color: "#c86a6a" }}>{lineError}</p>}
          </div>
        )}
      </section>

      <section>
        <h2>Actions</h2>
        <ConfirmButton
          label="Start"
          eligible={task.status === "Pending"}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => startPickingTask(task.id, crypto.randomUUID()).then(() => {})}
        />
        <ConfirmButton
          label="Complete"
          eligible={task.status === "InProgress"}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => completePickingTask(task.id, crypto.randomUUID()).then(() => {})}
        />
        <ConfirmButton
          label="Cancel Task"
          eligible={["Pending", "InProgress"].includes(task.status)}
          blockedByOther={blockedByOther}
          onBusyChange={(b) => setBusyCount((c) => c + (b ? 1 : -1))}
          onSuccess={load}
          run={() => cancelPickingTask(task.id, crypto.randomUUID()).then(() => {})}
        />
      </section>
    </main>
  );
}
