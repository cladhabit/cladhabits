import crypto from "crypto";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  try {
    const token = String(req.query?.token || "").trim();
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!token || token.length < 32) {
      return res.status(400).send("Invalid access link.");
    }

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).send("Access service is not configured.");
    }

    const tokenHash = sha256(token);

    const lookupUrl =
      supabaseUrl +
      "/rest/v1/product_access?access_token_hash=eq." +
      encodeURIComponent(tokenHash) +
      "&status=eq.active&select=id,expires_at";

    const lookup = await fetch(lookupUrl, {
      headers: {
        apikey: supabaseKey,
        Authorization: "Bearer " + supabaseKey
      }
    });

    if (!lookup.ok) {
      console.error("Access lookup failed:", await lookup.text());
      return res.status(500).send("Unable to verify access.");
    }

    const rows = await lookup.json();
    const record = rows && rows[0];

    if (!record) {
      return res.status(403).send(
        "This access link is invalid or has expired."
      );
    }

    if (
      record.expires_at &&
      new Date(record.expires_at).getTime() < Date.now()
    ) {
      return res.status(403).send("This access link has expired.");
    }

    const bucket = process.env.PRODUCT_BUCKET || "products";
    const objectPath =
      process.env.PRODUCT_OBJECT_PATH || "tracker.html";

    const encodedPath = objectPath
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    const signedResponse = await fetch(
      supabaseUrl +
        "/storage/v1/object/sign/" +
        encodeURIComponent(bucket) +
        "/" +
        encodedPath,
      {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: "Bearer " + supabaseKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          expiresIn: 3600
        })
      }
    );

    if (!signedResponse.ok) {
      console.error(
        "Signed URL creation failed:",
        await signedResponse.text()
      );

      return res.status(500).send(
        "Product access is not ready yet."
      );
    }

    const signedData = await signedResponse.json();
    const signedPath = signedData && signedData.signedURL;

    if (!signedPath) {
      return res.status(500).send(
        "Product access is not ready yet."
      );
    }

    const signedUrl = signedPath.startsWith("http")
      ? signedPath
      : supabaseUrl + "/storage/v1" + signedPath;

    await fetch(
      supabaseUrl +
        "/rest/v1/product_access?id=eq." +
        encodeURIComponent(record.id),
      {
        method: "PATCH",
        headers: {
          apikey: supabaseKey,
          Authorization: "Bearer " + supabaseKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          last_accessed_at: new Date().toISOString()
        })
      }
    );

    return res.redirect(302, signedUrl);

  } catch (error) {
    console.error("Access error:", error);
    return res.status(500).send(
      "Unable to open your product."
    );
  }
}
