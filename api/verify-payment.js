import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const { order_id, payment_id, signature } = req.body || {};

    if (!order_id || !payment_id || !signature) {
      return res.status(400).json({
        ok: false,
        error: "Missing payment verification fields"
      });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;

    if (!secret) {
      return res.status(500).json({
        ok: false,
        error: "Razorpay secret is not configured"
      });
    }

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(`${order_id}|${payment_id}`)
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
        verified: false,
        error: "Invalid payment signature"
      });
    }

    return res.status(200).json({
      ok: true,
      verified: true,
      order_id,
      payment_id
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Payment verification failed"
    });
  }
}
