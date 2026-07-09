"use client";

import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { emptyProductForm, ProductForm } from "@/components/ProductForm";
import type { ProductDetail } from "@/lib/types";

export default function NewProductPage() {
  const router = useRouter();

  return (
    <div>
      <h1>New Product</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      <ProductForm
        initialValues={emptyProductForm}
        submitLabel="Create Product"
        onSubmit={async (payload) => {
          const product = await api.post<ProductDetail>("/api/products", payload);
          router.push(`/products/${product.id}`);
        }}
      />
    </div>
  );
}
