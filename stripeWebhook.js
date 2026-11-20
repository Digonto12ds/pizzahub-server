
import express from "express";
import { ObjectId } from "mongodb";

export default function createStripeWebhookRouter({
  stripe,
  users,
  transactions,
}) {
  const router = express.Router();

  // Update vendor subscription information in MongoDB
  const updateVendorSubscription = async (
    subscription,
    vendorIdOverride
  ) => {
    const vendorId =
      vendorIdOverride || subscription.metadata?.vendorId;

    if (!vendorId) {
      throw new Error("Vendor ID not found in subscription metadata.");
    }

    const userConditions = [{ _id: String(vendorId) }];

    if (ObjectId.isValid(String(vendorId))) {
      userConditions.push({
        _id: new ObjectId(String(vendorId)),
      });
    }

    // Get subscription status
    const subscriptionStatus = subscription.status;

    // Active or trialing subscriptions get Premium access
    const subscriptionPlan = ["active", "trialing"].includes(
      subscriptionStatus
    )
      ? "premium"
      : "free";

    // Get Stripe customer ID
    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer?.id;

    // Get subscription expiry timestamp
    const currentPeriodEnd =
      subscription.current_period_end ??
      subscription.items?.data?.[0]?.current_period_end ??
      null;

    // Convert Stripe timestamp into JavaScript Date
    const subscriptionExpiresAt = currentPeriodEnd
      ? new Date(currentPeriodEnd * 1000)
      : null;

    // Update MongoDB user
    const result = await users.updateOne(
      { $or: userConditions },
      {
        $set: {
          subscriptionPlan,
          subscriptionStatus,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscription.id,
          subscriptionExpiresAt,
          cancelAtPeriodEnd: Boolean(
            subscription.cancel_at_period_end
          ),
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      throw new Error(`Vendor not found: ${vendorId}`);
    }

    console.log(
      `Vendor ${vendorId} subscription updated: ${subscriptionPlan}`
    );

    console.log("Subscription expires at:", subscriptionExpiresAt);
  };

  // Save Stripe invoice transaction in MongoDB
  const saveTransaction = async (
    invoice,
    subscription,
    status
  ) => {
    const vendorId = subscription.metadata?.vendorId;

    if (!vendorId) {
      throw new Error("Vendor ID not found in subscription metadata.");
    }

    const transactionData = {
      vendorId: String(vendorId),
      plan: subscription.metadata?.plan || "premium",

      // Stripe amount is stored in the smallest currency unit.
      // Example: 1000 cents = 10 USD.
      amount:
        status === "success"
          ? Number(invoice.amount_paid || 0) / 100
          : Number(invoice.amount_due || 0) / 100,

      currency: String(invoice.currency || "usd").toUpperCase(),

      stripeInvoiceId: invoice.id,
      stripeSubscriptionId: subscription.id,

      status,

      createdAt: new Date(
        (invoice.status_transitions?.paid_at ||
          invoice.created) * 1000
      ),

      updatedAt: new Date(),
    };

    // Prevent duplicate transactions when Stripe retries a webhook
    await transactions.updateOne(
      { stripeInvoiceId: invoice.id },
      {
        $set: transactionData,
      },
      { upsert: true }
    );

    console.log(
      `Transaction saved: ${invoice.id} - ${status}`
    );
  };

  router.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const signature = req.headers["stripe-signature"];

      let event;

      // Verify Stripe webhook signature
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          signature,
          process.env.STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error(
          "Webhook signature verification failed:",
          err.message
        );

        return res.status(400).send(
          `Webhook Error: ${err.message}`
        );
      }
      console.log("Stripe Event Received:", event.type);

      try {
        switch (event.type) {

          // 1. Checkout completed
          case "checkout.session.completed": {
            const checkoutSession = event.data.object;

            console.log(
              "Checkout completed:",
              checkoutSession.id
            );

            if (
              checkoutSession.mode !== "subscription" ||
              !checkoutSession.subscription
            ) {
              break;
            }

            const subscriptionId =
              typeof checkoutSession.subscription === "string"
                ? checkoutSession.subscription
                : checkoutSession.subscription.id;

            const subscription =
              await stripe.subscriptions.retrieve(subscriptionId);

            await updateVendorSubscription(
              subscription,
              checkoutSession.metadata?.vendorId ||
                checkoutSession.client_reference_id
            );

            break;
          }

          // 2. Subscription updated
          case "customer.subscription.updated": {
            const subscription = event.data.object;

            await updateVendorSubscription(subscription);

            break;
          }

          // 3. Subscription cancelled
          case "customer.subscription.deleted": {
            const subscription = event.data.object;

            await updateVendorSubscription(subscription);

            console.log(
              "Subscription cancelled:",
              subscription.id
            );

            break;
          }

          // 4. Successful payment
          case "invoice.paid": {
  const invoice = event.data.object;

  console.log("Invoice Paid Event:", invoice.id);

  console.log("Invoice Subscription:", invoice.subscription);

  console.log(
    "Invoice Parent:",
    JSON.stringify(invoice.parent, null, 2)
  );

  const subscriptionReference =
    invoice.subscription ||
    invoice.parent?.subscription_details?.subscription;

  const subscriptionId =
    typeof subscriptionReference === "string"
      ? subscriptionReference
      : subscriptionReference?.id;

  console.log("Extracted Subscription ID:", subscriptionId);

  if (!subscriptionId) {
    console.error(
      "Subscription ID missing for invoice:",
      invoice.id
    );
    break;
  }

  const subscription =
    await stripe.subscriptions.retrieve(subscriptionId);

  console.log(
    "Subscription Metadata:",
    subscription.metadata
  );

  await updateVendorSubscription(subscription);

  await saveTransaction(
    invoice,
    subscription,
    "success"
  );

  console.log("Invoice transaction saved:", invoice.id);

  break;
}

          // 5. Payment failed
          case "invoice.payment_failed": {
            const invoice = event.data.object;

            const subscriptionReference =
              invoice.subscription ||
              invoice.parent?.subscription_details?.subscription;

            const subscriptionId =
              typeof subscriptionReference === "string"
                ? subscriptionReference
                : subscriptionReference?.id;

            if (subscriptionId) {
              const subscription =
                await stripe.subscriptions.retrieve(subscriptionId);

              await updateVendorSubscription(subscription);

              await saveTransaction(
                invoice,
                subscription,
                "failed"
              );
            } else {
              console.log(
                "Could not find subscription ID for failed invoice:",
                invoice.id
              );
            }

            break;
          }

          default:
            console.log("Unhandled event type:", event.type);
        }

        res.json({ received: true });

      } catch (err) {
        console.error("Webhook processing error:", err);

        res.status(500).json({
          error: "Webhook processing failed",
        });
      }
    }
  );

  return router;
}
