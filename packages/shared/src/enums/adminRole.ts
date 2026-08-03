export enum AdminRole {
  Owner = "owner",
  Admin = "admin",
  ProductEditor = "product_editor",
  OrderManager = "order_manager",
  SupportAgent = "support_agent",
  AiReviewer = "ai_reviewer",
}

export const ADMIN_ROLE_VALUES: AdminRole[] = Object.values(AdminRole);

/**
 * Foundation-level permission map. Not enforced yet — Sprint 1 only
 * establishes the shape so route/UI guards can be wired up later.
 */
export type Permission =
  | "products.view"
  | "products.edit"
  | "products.publish"
  | "orders.view"
  | "orders.manage"
  | "customers.view"
  | "customers.manage"
  | "ai_drafts.view"
  | "ai_drafts.review"
  | "ai_product_intakes.view"
  | "ai_product_intakes.manage"
  | "settings.manage"
  | "users.manage"
  | "marketplace.view"
  | "marketplace.manage"
  | "analytics.view"
  | "system.admin";

export const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  [AdminRole.Owner]: [
    "products.view",
    "products.edit",
    "products.publish",
    "orders.view",
    "orders.manage",
    "customers.view",
    "customers.manage",
    "ai_drafts.view",
    "ai_drafts.review",
    "ai_product_intakes.view",
    "ai_product_intakes.manage",
    "settings.manage",
    "users.manage",
    "marketplace.view",
    "marketplace.manage",
    "analytics.view",
    "system.admin",
  ],
  [AdminRole.Admin]: [
    "products.view",
    "products.edit",
    "products.publish",
    "orders.view",
    "orders.manage",
    "customers.view",
    "customers.manage",
    "ai_drafts.view",
    "ai_drafts.review",
    "ai_product_intakes.view",
    "ai_product_intakes.manage",
    "settings.manage",
    "marketplace.view",
    "marketplace.manage",
    "analytics.view",
  ],
  [AdminRole.ProductEditor]: ["products.view", "products.edit", "ai_product_intakes.view", "ai_product_intakes.manage"],
  [AdminRole.OrderManager]: ["orders.view", "orders.manage", "customers.view"],
  [AdminRole.SupportAgent]: ["customers.view", "orders.view"],
  [AdminRole.AiReviewer]: ["ai_drafts.view", "ai_drafts.review", "products.view"],
};
