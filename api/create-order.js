export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const price = Number(process.env.PRODUCT_PRICE_PAISE || 19900);

    if (!keyId || !keySecret) {
      return res.status(500).json({
        ok: false,
        error: "Razorpay credentials are not configured"
      });
    }

    if (!Number.isInteger(price) || price < 100) {
      return res.status(500).json({
        ok: false,
        error: "Invalid product price"
      });
    }

    const auth = Buffer
      .from(`${keyId}:${keySecret}`)
      .toString("base64");

    const response = await fetch(
      "https://api.razorpay.com/v1/orders",
      {
        method: "POST",

        headers: {
          "Authorization": `Basic ${auth}`,
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          amount: price,
          currency: "INR",
          receipt: `cladhabits_${Date.now()}`
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error:
          data?.error?.description ||
          "Unable to create Razorpay order"
      });
    }

    return res.status(200).json({
      ok: true,
      key_id: keyId,
      order_id: data.id,
      amount: data.amount,
      currency: data.currency
    });

  } catch (error) {

    console.error("Create order error:", error);

    return res.status(500).json({
      ok: false,
      error: "Server error while creating payment order"
    });
  }
}
