"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { PublicCategory } from "@/lib/types";

export default function CategoriesPage() {
  const [categories, setCategories] = useState<PublicCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ items: PublicCategory[] }>("/api/public/categories")
      .then((res) => setCategories(res.items))
      .catch(() => setError("Something went wrong loading categories. Please try again."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <section style={{ padding: "48px 40px" }}>
      <h1>Categories</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      {loading && (
        <p role="status" style={{ color: "var(--noctella-aged-bronze)", padding: "40px 0", textAlign: "center" }}>
          Loading...
        </p>
      )}

      {error && (
        <p role="alert" style={{ color: "#c86a6a", padding: "40px 0", textAlign: "center" }}>
          {error}
        </p>
      )}

      {!loading && !error && categories.length === 0 && (
        <p style={{ color: "var(--noctella-aged-bronze)", padding: "40px 0", textAlign: "center" }}>
          No categories are available yet.
        </p>
      )}

      {!loading && !error && categories.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 16,
          }}
        >
          {categories.map((category) => (
            <Link
              key={category.id}
              href={`/category/${category.slug}`}
              className="noctella-panel"
              style={{
                display: "block",
                padding: 20,
                textAlign: "center",
                textDecoration: "none",
                color: "var(--noctella-ivory)",
                fontSize: 14,
              }}
            >
              {category.name}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
