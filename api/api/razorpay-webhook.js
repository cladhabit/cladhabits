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
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      );
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

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(a),
    Buffer.from(b)
  );
}

async function sendAccessEmail(to, accessUrl, paymentId) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log("RESEND_API_KEY not configured.");
    return false;
  }

  const from =
    process.env.RESEND_FROM_EMAIL ||
    "onboarding@resend.dev";

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",

      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        from,

        to: [to],

        subject:
          "Your CLADHABITS Habit Tracker is ready!",

        html:
          '<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;padding:32px;color:#101828">' +

          "<h1>Your CLADHABITS Habit Tracker is ready 🎉</h1>" +

          "<p>Your payment was successful and your product access has been created.</p>" +

          '<p><a href="' +
          accessUrl +
          '" style="display:inline-block;padding:14px 20px;border-radius:10px;background:#2447d8;color:#fff;text-decoration:none;font-weight:700">Open My Habit Tracker</a></p>' +

          '<p style="color:#667085;font-size:13px">Payment ID: ' +
          paymentId +
          "</p>" +

          '<p style="color:#667085;font-size:12px">CLADHABITS</p>' +

          "</div>"
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error(
      "Resend email failed:",
      data
    );

    return false;
  }

  console.log(
    "Access email sent:",
    data?.id
  );

  return true;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const webhookSecrets = [
      process.env.RAZORPAY_WEBHOOK_SECRET,
      process.env.RAZORPAY_TEST_WEBHOOK_SECRET
    ].filter(Boolean);

    const supabaseUrl =
      process.env.SUPABASE_URL;

    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY;

    const signature =
      req.headers["x-razorpay-signature"];

    if (
      !webhookSecrets.length ||
      !supabaseUrl ||
      !supabaseKey
    ) {
      return res.status(500).json({
        ok: false,
        error:
          "Required environment variables are not configured"
      });
    }

    if (!signature) {
      return res.status(400).json({
        ok: false,
        error:
          "Missing Razorpay webhook signature"
      });
    }

    const rawBody =
      await readRawBody(req);

    const valid =
      webhookSecrets.some((secret) => {
        const expected =
          crypto
            .createHmac("sha256", secret)
            .update(rawBody)
            .digest("hex");

        return safeEqual(
          expected,
          signature
        );
      });

    if (!valid) {
      return res.status(400).json({
        ok: false,
        error:
          "Invalid webhook signature"
      });
    }

    const event =
      JSON.parse(rawBody);

    const eventName =
      event?.event || "";

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
      event?.payload?.payment?.entity || {};

    const paymentLink =
      event?.payload?.payment_link?.entity || {};

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
      return res.status(400).json({
        ok: false,
        error:
          "Payment ID or customer email missing"
      });
    }

    const customerEmail =
      email.toLowerCase().trim();

    const existingResponse =
      await fetch(
        supabaseUrl +
          "/rest/v1/product_access?razorpay_payment_id=eq." +
          encodeURIComponent(paymentId) +
          "&select=id&limit=1",
        {
          headers: {
            apikey: supabaseKey,
            Authorization:
              "Bearer " + supabaseKey
          }
        }
      );

    if (!existingResponse.ok) {
      console.error(
        "Existing access lookup failed:",
        await existingResponse.text()
      );

      return res.status(500).json({
        ok: false,
        error:
          "Unable to check existing product access"
      });
    }

    const existingRows =
      await existingResponse.json();

    if (
      existingRows &&
      existingRows.length
    ) {
      return res.status(200).json({
        ok: true,
        received: true,
        duplicate: true,
        payment_id: paymentId
      });
    }

    const accessToken =
      crypto.randomBytes(32).toString("hex");

    const accessTokenHash =
      sha256(accessToken);

    const expiresAt =
      new Date(
        Date.now() +
          30 * 24 * 60 * 60 * 1000
      ).toISOString();

    const insertResponse =
      await fetch(
        supabaseUrl +
          "/rest/v1/product_access",
        {
          method: "POST",

          headers: {
            apikey: supabaseKey,
            Authorization:
              "Bearer " + supabaseKey,
            "Content-Type":
              "application/json",
            Prefer: "return=minimal"
          },

          body: JSON.stringify({
            customer_email:
              customerEmail,

            product_slug:
              "cladhabits-habit-tracker",

            razorpay_payment_id:
              paymentId,

            razorpay_order_id:
              orderId,

            access_token_hash:
              accessTokenHash,

            status:
              "active",

            expires_at:
              expiresAt
          })
        }
      );

    if (!insertResponse.ok) {
      console.error(
        "Supabase insert failed:",
        await insertResponse.text()
      );

      return res.status(500).json({
        ok: false,
        error:
          "Unable to create product access record"
      });
    }

    const accessBaseUrl =
      process.env.PRODUCT_ACCESS_BASE_URL ||
      "https://cladhabits.vercel.app/api/access";

    const accessUrl =
      accessBaseUrl +
      "?token=" +
      encodeURIComponent(accessToken);

    const emailSent =
      await sendAccessEmail(
        customerEmail,
        accessUrl,
        paymentId
      );

    console.log(
      "CLADHABITS DELIVERY CREATED",
      {
        event: eventName,
        paymentId,
        email: customerEmail,
        emailSent
      }
    );

    return res.status(200).json({
      ok: true,
      received: true,
      event: eventName,
      payment_id: paymentId,
      email_sent: emailSent
    });

  } catch (error) {
    console.error(
      "Webhook processing error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "Webhook processing failed"
    });
  }
}
