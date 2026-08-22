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
  const[salePausedAt,setSalePausedAt]=useState<string|undefined>();

  useEffect(() => {
    api
      .get<ProductDetail>(`/api/products/${params.id}`)
      .then((product) => {
        setInitialValues(productToFormValues(product));
        setExpectedUpdatedAt(product.updatedAt);
        setSalePausedAt(product.salePausedAt);
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
        productSalePausedAt={salePausedAt}
        onLifecycleVersionResult={(before,after)=>setExpectedUpdatedAt(current=>current===before?after:current)}
        onSubmit={async (payload) => {
          const updated = await api.put<ProductDetail>(`/api/products/${params.id}`, { ...payload, expectedUpdatedAt });
          setExpectedUpdatedAt(updated.updatedAt);
          // Sprint 147: a successful generic Save now returns the admin to the Pending Publish
          // queue rather than the Product Detail page - the just-saved Product may or may not be
          // eligible there depending on Stock Acceptance provenance/status/publish-evidence
          // (unchanged Sprint 142 predicate), which is expected and not corrected for here.
          router.push("/ready-to-publish");
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
        // Sprint 147: fired by PublishActions (via ProductForm) only after a resolved
        // executePublishBatch response has already completed the canonical Product refetch -
        // regardless of per-channel outcome. EditProductPage is the sole navigation owner
        // (Option B); PublishActions/ProductForm own no router logic themselves.
        onPublishComplete={() => router.push("/products")}
      />
    </div>
  );
}
