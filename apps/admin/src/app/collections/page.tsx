"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Collection, PaginatedResult } from "@/lib/types";

interface FormState {
  id?: string;
  name: string;
  slug: string;
  description: string;
  coverImageUrl: string;
  seoTitle: string;
  metaDescription: string;
  displayOrder: string;
  isActive: boolean;
}

const emptyForm: FormState = {
  name: "",
  slug: "",
  description: "",
  coverImageUrl: "",
  seoTitle: "",
  metaDescription: "",
  displayOrder: "0",
  isActive: true,
};

export default function CollectionsPage() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function refresh() {
    const res = await api.get<PaginatedResult<Collection>>(
      "/api/collections?pageSize=100&includeInactive=true",
    );
    setCollections(res.items);
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, []);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function edit(collection: Collection) {
    setForm({
      id: collection.id,
      name: collection.name,
      slug: collection.slug,
      description: collection.description ?? "",
      coverImageUrl: collection.coverImageUrl ?? "",
      seoTitle: collection.seoTitle ?? "",
      metaDescription: collection.metaDescription ?? "",
      displayOrder: String(collection.displayOrder),
      isActive: collection.isActive,
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});
    const payload = {
      name: form.name,
      slug: form.slug || undefined,
      description: form.description || undefined,
      coverImageUrl: form.coverImageUrl || undefined,
      seoTitle: form.seoTitle || undefined,
      metaDescription: form.metaDescription || undefined,
      displayOrder: Number(form.displayOrder) || 0,
      isActive: form.isActive,
    };
    try {
      if (form.id) {
        await api.put(`/api/collections/${form.id}`, payload);
      } else {
        await api.post("/api/collections", payload);
      }
      setForm(emptyForm);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        if (err.details) {
          const mapped: Record<string, string> = {};
          for (const d of err.details) mapped[d.path] = d.message;
          setFieldErrors(mapped);
        }
      } else {
        setError("Something went wrong.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(collection: Collection) {
    if (collection.isActive) {
      await api.post(`/api/collections/${collection.id}/archive`, {});
    } else {
      await api.post(`/api/collections/${collection.id}/restore`, {});
    }
    await refresh();
  }

  return (
    <div>
      <h1>Collections</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      <div style={{ display: "flex", gap: 32 }}>
        <div className="noctella-panel" style={{ flex: 1, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--noctella-antique-gold)" }}>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Slug</th>
                <th style={thStyle}>Order</th>
                <th style={thStyle}>Active</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {collections.map((c) => (
                <tr key={c.id} style={{ borderBottom: "1px solid rgba(122,106,79,0.3)" }}>
                  <td style={tdStyle}>{c.name}</td>
                  <td style={tdStyle}>{c.slug}</td>
                  <td style={tdStyle}>{c.displayOrder}</td>
                  <td style={tdStyle}>{c.isActive ? "Yes" : "No"}</td>
                  <td style={tdStyle}>
                    <button style={linkButtonStyle} onClick={() => edit(c)}>
                      Edit
                    </button>
                    <button style={linkButtonStyle} onClick={() => toggleActive(c)}>
                      {c.isActive ? "Archive" : "Restore"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form
          onSubmit={handleSubmit}
          className="noctella-panel"
          style={{ width: 340, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}
        >
          <h3 style={{ margin: 0 }}>{form.id ? "Edit Collection" : "New Collection"}</h3>
          {error && <p style={{ color: "#c86a6a", fontSize: 13 }}>{error}</p>}
          <Field label="Name" error={fieldErrors.name}>
            <input style={inputStyle} value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Slug (optional)">
            <input style={inputStyle} value={form.slug} onChange={(e) => set("slug", e.target.value)} />
          </Field>
          <Field label="Description">
            <textarea
              style={{ ...inputStyle, minHeight: 60 }}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </Field>
          <Field label="Cover Image URL">
            <input
              style={inputStyle}
              value={form.coverImageUrl}
              onChange={(e) => set("coverImageUrl", e.target.value)}
            />
          </Field>
          <Field label="SEO Title">
            <input style={inputStyle} value={form.seoTitle} onChange={(e) => set("seoTitle", e.target.value)} />
          </Field>
          <Field label="Meta Description">
            <input
              style={inputStyle}
              value={form.metaDescription}
              onChange={(e) => set("metaDescription", e.target.value)}
            />
          </Field>
          <Field label="Display Order">
            <input
              style={inputStyle}
              value={form.displayOrder}
              onChange={(e) => set("displayOrder", e.target.value)}
            />
          </Field>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} />
            Active
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="submit"
              disabled={saving}
              style={{
                padding: "10px 18px",
                background: "var(--noctella-antique-gold)",
                color: "var(--noctella-night-navy)",
                border: "none",
                borderRadius: 4,
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {saving ? "Saving..." : form.id ? "Save Changes" : "Create Collection"}
            </button>
            {form.id && (
              <button type="button" style={linkButtonStyle} onClick={() => setForm(emptyForm)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
      <span style={{ color: "var(--noctella-aged-bronze)" }}>{label}</span>
      {children}
      {error && <span style={{ color: "#c86a6a", fontSize: 12 }}>{error}</span>}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--noctella-night-navy)",
  border: "1px solid var(--noctella-aged-bronze)",
  color: "var(--noctella-ivory)",
  borderRadius: 4,
  padding: "8px 10px",
  fontSize: 13,
};

const thStyle: React.CSSProperties = {
  padding: "10px 12px",
  color: "var(--noctella-bright-star-gold)",
  fontWeight: 500,
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
};

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--noctella-bright-star-gold)",
  cursor: "pointer",
  fontSize: 13,
  marginRight: 12,
  padding: 0,
};
