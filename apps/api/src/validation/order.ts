import {
  ORDER_STATUS_VALUES,
  PAYMENT_PROVIDER_VALUES,
  PAYMENT_STATUS_VALUES,
  PRICE_CURRENCY_VALUES,
  OrderStatus,
  PaymentStatus,
  PriceCurrency,
} from "@noctella/shared";
import { z } from "zod";

const addressSchema = z.object({
  fullName: z.string().min(1),
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  region: z.string().optional(),
  postalCode: z.string().min(1),
  country: z.string().min(1),
  phone: z.string().optional(),
});

const orderItemInputSchema = z.object({
  productId: z.string().min(1),
  quantity: z.literal(1).default(1),
});

export const createOrderSchema = z.object({
  orderDraftId: z.string().min(1),
  customerId: z.string().min(1).optional(),
  guestEmail: z.string().email(),
  status: z.enum(ORDER_STATUS_VALUES as [OrderStatus, ...OrderStatus[]]).default(OrderStatus.Pending),
  paymentStatus: z.enum(PAYMENT_STATUS_VALUES as [PaymentStatus, ...PaymentStatus[]]),
  paymentProvider: z.enum(PAYMENT_PROVIDER_VALUES as [string, ...string[]]),
  paymentReference: z.string().min(1),
  currency: z.enum(PRICE_CURRENCY_VALUES as [PriceCurrency, ...PriceCurrency[]]).default(PriceCurrency.Eur),
  billingAddress: addressSchema,
  shippingAddress: addressSchema,
  subtotalAmount: z.number().min(0),
  totalAmount: z.number().min(0),
  notes: z.string().optional(),
  items: z.array(orderItemInputSchema).min(1),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(ORDER_STATUS_VALUES as [OrderStatus, ...OrderStatus[]]),
});

export const orderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  status: z.enum(ORDER_STATUS_VALUES as [OrderStatus, ...OrderStatus[]]).optional(),
  paymentStatus: z.enum(PAYMENT_STATUS_VALUES as [PaymentStatus, ...PaymentStatus[]]).optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;
