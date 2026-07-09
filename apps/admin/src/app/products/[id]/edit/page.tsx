"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ProductForm, productToFormValues, type ProductFormValues } from "@/components/ProductForm";
import type { ProductDetail } from "@/lib/types";

export default function EditProductPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [initialValues, setInitialValues] = useState<ProductFormValues | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ProductDetail>(`/api/products/${params.id}`)
      .then((product) => setInitialValues(productToFormValues(product)))
      .catch((err) => setError(err.message ?? "Failed to load product"));
  }, [params.id]);

  if (error) return <p style={{ color: "#c86a6a" }}>{error}</p>;
  if (!initialValues) return <p style={{ color: "var(--noctella-aged-bronze)" }}>Loading...</p>;

  return (
    <div>
      <h1>Edit Product</h1>
      <hr className="noctella-divider" style={{ margin: "16px 0 24px" }} />
      <ProductForm
        initialValues={initialValues}
        submitLabel="Save Changes"
        onSubmit={async (payload) => {
          await api.put<ProductDetail>(`/api/products/${params.id}`, payload);
          router.push(`/products/${params.id}`);
        }}
      />
    </div>
  );
}
