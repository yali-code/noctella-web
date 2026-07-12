export enum PaymentProvider {
  Stripe = "stripe",
  PayPal = "paypal",
  CashOnDelivery = "cash_on_delivery",
}

export const PAYMENT_PROVIDER_VALUES: PaymentProvider[] = Object.values(PaymentProvider);
