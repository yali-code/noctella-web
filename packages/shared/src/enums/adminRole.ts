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
  | "settings.manage"
  | "users.manage";

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
    "settings.manage",
    "users.manage",
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
    "settings.manage",
  ],
  [AdminRole.ProductEditor]: ["products.view", "products.edit"],
  [AdminRole.OrderManager]: ["orders.view", "orders.manage", "customers.view"],
  [AdminRole.SupportAgent]: ["customers.view", "orders.view"],
  [AdminRole.AiReviewer]: ["ai_drafts.view", "ai_drafts.review", "products.view"],
};
