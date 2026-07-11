"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { PublicCollection } from "@/lib/types";

export default function CollectionsIndexPage() {
  const [collections, setCollections] = useState<PublicCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ items: PublicCollection[] }>("/api/public/collections")
      .then((res) => setCollections(res.items))
      .catch(() => setError("Something went wrong loading collections. Please try again."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <section style={{ padding: "48px 40px" }}>
      <h1>Collections</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />

      {loading && (
        <p role="status" style={{ color: "var(--noctella-aged-bronze)" }}>
          Loading...
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: "#c86a6a" }}>
          {error}
        </p>
      )}
      {!loading && !error && collections.length === 0 && (
        <p style={{ color: "var(--noctella-aged-bronze)" }}>No collections available yet.</p>
      )}

      {!loading && !error && collections.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: 20,
          }}
        >
          {collections.map((collection) => (
            <Link
              key={collection.id}
              href={`/collection/${collection.slug}`}
              className="noctella-panel"
              style={{ display: "block", textDecoration: "none", color: "var(--noctella-ivory)", overflow: "hidden" }}
            >
              {collection.coverImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={collection.coverImageUrl}
                  alt={collection.name}
                  style={{ width: "100%", height: 160, objectFit: "cover" }}
                />
              ) : (
                <div style={{ width: "100%", height: 160, background: "var(--noctella-night-navy)" }} />
              )}
              <div style={{ padding: 16 }}>
                <h3 style={{ margin: "0 0 6px" }}>{collection.name}</h3>
                {collection.description && (
                  <p style={{ margin: 0, fontSize: 13, color: "var(--noctella-aged-bronze)" }}>
                    {collection.description}
                  </p>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
