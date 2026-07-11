import type { PublicProduct } from "@/lib/types";
import { ProductCard } from "./ProductCard";

interface ProductGridProps {
  products: PublicProduct[];
  loading: boolean;
  error: string | null;
  emptyMessage?: string;
}

export function ProductGrid({ products, loading, error, emptyMessage }: ProductGridProps) {
  if (loading) {
    return (
      <p role="status" style={{ color: "var(--noctella-aged-bronze)", padding: "40px 0", textAlign: "center" }}>
        Loading...
      </p>
    );
  }

  if (error) {
    return (
      <p role="alert" style={{ color: "#c86a6a", padding: "40px 0", textAlign: "center" }}>
        {error}
      </p>
    );
  }

  if (products.length === 0) {
    return (
      <p style={{ color: "var(--noctella-aged-bronze)", padding: "40px 0", textAlign: "center" }}>
        {emptyMessage ?? "No items found."}
      </p>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: 20,
      }}
    >
      {products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}
