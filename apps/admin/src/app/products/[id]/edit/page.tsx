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
  // Sprint 88: EditProductPage owns the version token separately from
  // ProductFormValues - initialized from the exact Product.updatedAt returned
  // by GET, replaced with the response's updatedAt after a successful save,
  // and left unchanged on a PRODUCT_VERSION_CONFLICT (the PUT call below
  // throws before reaching the line that would update it).
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ProductDetail>(`/api/products/${params.id}`)
      .then((product) => {
        setInitialValues(productToFormValues(product));
        setExpectedUpdatedAt(product.updatedAt);
      })
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
        productId={params.id}
        productUpdatedAt={expectedUpdatedAt ?? undefined}
        onSubmit={async (payload) => {
          const updated = await api.put<ProductDetail>(`/api/products/${params.id}`, { ...payload, expectedUpdatedAt });
          setExpectedUpdatedAt(updated.updatedAt);
          router.push(`/products/${params.id}`);
        }}
        onVersionConflictReload={() => window.location.reload()}
        // Sprint 145: a successful inline Marketplace Preparation Approve (inside ProductForm)
        // mutates the canonical Product outside this page's own onSubmit flow - the version token
        // this page owns (Sprint 88) must advance to match, or the next Save Changes would be
        // incorrectly rejected as a version conflict. Sprint 146: a successful Save-before-Publish
        // (see onSaveForPublish below) advances it through this exact same callback.
        onProductVersionAdvanced={(updatedAt) => setExpectedUpdatedAt(updatedAt)}
        // Sprint 146: the narrow Save-before-Publish path PublishActions uses (via ProductForm's
        // own saveForPublish) - the exact same PUT endpoint and expectedUpdatedAt contract as
        // onSubmit above, but never navigates away and returns the updated Product so ProductForm
        // can refresh its own visible values/persisted baseline. This page's own expectedUpdatedAt
        // is advanced by ProductForm calling onProductVersionAdvanced above, not duplicated here.
        onSaveForPublish={(payload) => api.put<ProductDetail>(`/api/products/${params.id}`, { ...payload, expectedUpdatedAt })}
      />
    </div>
  );
}
