import type { RefundRepositories } from "../repositories/refund/types";
import type { UnitOfWork } from "./unitOfWork";
import type { RefundExecutionRequest as RefundProviderRequest, RefundProviderResponse, MarketplaceRefundPort, PaymentRefundPort, RefundProviderRegistry } from "../providers/refund";
export type { RefundProviderRequest, RefundProviderResponse, MarketplaceRefundPort, PaymentRefundPort, RefundProviderRegistry };

export type RefundReadPortResult<T> = T | null | Promise<T | null>;
export type RefundReadPortList<T> = T[] | Promise<T[]>;

export interface RefundOrderDto {
  id: string;
  currency: string;
  customerId?: string | null;
  marketplaceOrderId?: string | null;
  paymentId?: string | null;
  totalAmount?: number | null;
}

export interface RefundOrderItemDto {
  id: string;
  orderId: string;
  productId?: string | null;
  quantity: number;
  refundableAmount: number;
  currency: string;
}

export interface ApprovedReturnDto {
  id: string;
  orderId: string;
  status: string;
  approvedAt: string;
}

export interface ApprovedReturnItemDto {
  id: string;
  returnRequestId: string;
  orderItemId: string;
  quantity: number;
  refundableAmount: number;
}

export interface MarketplaceConnectionDto {
  id: string;
  orderId?: string | null;
  marketplace: string;
  providerKey: string;
  merchantId?: string | null;
}

export interface PaymentTransactionDto {
  id: string;
  orderId: string;
  providerKey: string;
  currency: string;
  capturedAmount: number;
  refundedAmount: number;
}

export interface OrderRefundReadPort {
  findRefundOrder(orderId: string): RefundReadPortResult<RefundOrderDto>;
  findRefundItems(orderId: string): RefundReadPortList<RefundOrderItemDto>;
}

export interface ReturnRefundReadPort {
  findApprovedReturn(returnRequestId: string): RefundReadPortResult<ApprovedReturnDto>;
  findApprovedItems(returnRequestId: string): RefundReadPortList<ApprovedReturnItemDto>;
}

export interface MarketplaceConnectionReadPort {
  findConnection(orderId: string): RefundReadPortResult<MarketplaceConnectionDto>;
  resolveProvider(connection: MarketplaceConnectionDto): string | Promise<string>;
}

export interface PaymentTransactionReadPort {
  findPayment(orderId: string): RefundReadPortResult<PaymentTransactionDto>;
  findRemainingRefundAmount(paymentTransactionId: string): number | Promise<number>;
}

export interface RefundReadPorts {
  orders: OrderRefundReadPort;
  returns: ReturnRefundReadPort;
  marketplaceConnections: MarketplaceConnectionReadPort;
  payments: PaymentTransactionReadPort;
}

export interface Clock { now(): Date; }
export interface IdGenerator { newId(): string; }

export interface RefundExecutionQueue {
  enqueueRefundExecution(refundId: string): void | Promise<void>;
  cancelRefundExecution(refundId: string): void | Promise<void>;
}

export interface RefundLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface RefundErrorNormalizer {
  normalize(error: unknown): { code: string; message: string; cause?: unknown };
}

export interface RefundApplicationContext {
  unitOfWork: UnitOfWork;
  repositories: RefundRepositories;
  readPorts: RefundReadPorts;
  providerPorts: RefundProviderRegistry;
  clock: Clock;
  idGenerator: IdGenerator;
  enqueue: RefundExecutionQueue;
  logger: RefundLogger;
  errorNormalizer: RefundErrorNormalizer;
}

export type CreateRefundApplicationContextInput = RefundApplicationContext;

const requiredKeys: Array<keyof CreateRefundApplicationContextInput> = [
  "unitOfWork",
  "repositories",
  "readPorts",
  "providerPorts",
  "clock",
  "idGenerator",
  "enqueue",
  "logger",
  "errorNormalizer",
];

export function createRefundApplicationContext(dependencies: CreateRefundApplicationContextInput): RefundApplicationContext {
  for (const key of requiredKeys) {
    if (dependencies[key] == null) throw new Error(`REFUND_APPLICATION_CONTEXT_MISSING_${key}`);
  }
  return Object.freeze({ ...dependencies });
}
