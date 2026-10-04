import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false
  }
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!webhookSecret || !supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        ok: false,
        error: "Required environment variables are not configured"
      });
    }

    const signature = req.headers["x-razorpay-signature"];

    if (!signature) {
      return res.status(400).json({
        ok: false,
        error: "Missing Razorpay webhook signature"
      });
    }

    const rawBody = await readRawBody(req);

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(rawBody)
      .digest("hex");

    const valid =
      expectedSignature.length === signature.length &&
      crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(signature)
      );

    if (!valid) {
      return res.status(400).json({
        ok: false,
        error: "Invalid webhook signature"
      });
    }

    const event = JSON.parse(rawBody);
    const eventName = event?.event || "";

    if (
      eventName !== "payment_link.paid" &&
      eventName !== "payment.captured"
    ) {
      return res.status(200).json({
        ok: true,
        received: true,
        ignored: true,
        event: eventName
      });
    }

    const payment =
      event?.payload?.payment?.entity ||
      {};

    const paymentLink =
      event?.payload?.payment_link?.entity ||
      {};

    const paymentId =
      payment?.id ||
      paymentLink?.payment_id ||
      null;

    const orderId =
      payment?.order_id ||
      null;

    const email =
      payment?.email ||
      paymentLink?.customer_details?.email ||
      paymentLink?.customer?.email ||
      null;

    if (!paymentId || !email) {
      console.error("Missing payment/customer information", {
        event: eventName,
        paymentId,
        email
      });

      return res.status(400).json({
        ok: false,
        error: "Payment ID or customer email missing"
      });
    }

    /*
      Generate a random access token.

      Only the SHA-256 hash is stored in Supabase.
      The actual token is never stored in the database.
    */
    const accessToken = crypto.randomBytes(32).toString("hex");
    const accessTokenHash = sha256(accessToken);

    const supabaseResponse = await fetch(
      `${supabaseUrl}/rest/v1/product_access`,
      {
        method: "POST",
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        body: JSON.stringify({
          customer_email: email.toLowerCase().trim(),
          product_slug: "cladhabits-habit-tracker",
          razorpay_payment_id: paymentId,
          razorpay_order_id: orderId,
          access_token_hash: accessTokenHash,
          status: "active"
        })
      }
    );

    if (!supabaseResponse.ok) {
      const errorText = await supabaseResponse.text();

      console.error("Supabase insert failed:", errorText);

      /*
        If the same payment webhook arrives twice,
        don't treat the duplicate as a new purchase.
      */
      if (!errorText.includes("duplicate")) {
        return res.status(500).json({
          ok: false,
          error: "Unable to create product access record"
        });
      }
    }

    console.log("CLADHABITS PAYMENT VERIFIED", {
      event: eventName,
      paymentId,
      email
    });

    /*
      NEXT DELIVERY STEP:
      Send the customer their secure product-access link
      using the accessToken generated above.

      The tracker itself must NOT be made public.
    */

    return res.status(200).json({
      ok: true,
      received: true,
      event: eventName,
      payment_id: paymentId
    });

  } catch (error) {
    console.error("Webhook processing error:", error);

    return res.status(500).json({
      ok: false,
      error: "Webhook processing failed"
    });
  }
}
